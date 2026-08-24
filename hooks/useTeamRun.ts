/**
 * useTeamRun —— 项目组前端状态 hook。
 *  - 加载团队配置 + 群聊历史 + 运行历史
 *  - 发布任务 → SSE 订阅（事件流 + run_update）
 *  - 事件流数组 + reduce 投影重建（一致性由 lib/team/types reduce 保证）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { reduce } from "@/lib/team/types";
import type {
  AgentExecution,
  Projections,
  TeamDef,
  TeamEvent,
  TeamMessage,
  TeamRun,
  TeamTask,
} from "@/lib/team/types";

export interface RunMeta {
  id: string;
  task: string;
  status: string;
  statusReason?: { code: string; message: string };
  createdAt: number;
  agentExecutions: number;
}

export interface TeamChatData {
  team: TeamDef | null;
  /** 转换导入 + 非 run 消息（chat.jsonl） */
  chatMessages: TeamMessage[];
  runs: RunMeta[];
  /** 当前订阅的 run 投影 */
  activeRunId: string | null;
  run: TeamRun | null;
  projections: Projections;
  events: TeamEvent[];
  connected: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  startRun: (task: string, startAgentId?: string) => Promise<string>;
  cancelRun: () => Promise<void>;
  steer: (content: string, agentId?: string) => Promise<void>;
}

export function useTeamRun(sessionId: string): TeamChatData {
  const [team, setTeam] = useState<TeamDef | null>(null);
  const [chatMessages, setChatMessages] = useState<TeamMessage[]>([]);
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [run, setRun] = useState<TeamRun | null>(null);
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  // 事件流 → 投影（依赖 reduce 纯函数，全量重建保证一致性）
  const projections = useMemoProjections(events);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [teamRes, runsRes] = await Promise.all([
        fetch(`/api/teams/${encodeURIComponent(sessionId)}`),
        fetch(`/api/teams/${encodeURIComponent(sessionId)}/runs`),
      ]);
      if (!teamRes.ok) throw new Error(`team load failed: ${teamRes.status}`);
      const teamData = await teamRes.json();
      setTeam(teamData.team ?? null);
      setChatMessages(teamData.chat ?? []);

      if (runsRes.ok) {
        const runsData = await runsRes.json();
        setRuns(
          (runsData.runs ?? []).map((r: RunMeta) => r),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const subscribeRun = useCallback((runId: string) => {
    esRef.current?.close();
    setEvents([]);
    setActiveRunId(runId);
    setConnected(false);

    // 先拉全量详情（事件数组初始值）
    void fetch(`/api/teams/runs/${runId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.events) setEvents(data.events);
        if (data?.run) setRun(data.run);
      })
      .catch(() => undefined);

    const es = new EventSource(`/api/teams/runs/${runId}/events`);
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.addEventListener("run_update", (ev) => {
      try {
        setRun(JSON.parse((ev as MessageEvent).data) as TeamRun);
      } catch { /* ignore */ }
    });
    // 其余事件类型（message_created/execution_started/...）追加到事件流
    const eventTypes = [
      "message_created", "execution_started", "execution_completed",
      "task_created", "task_completed", "task_failed",
      "artifact_produced", "decision_recorded", "handoff_requested",
      "steer", "run_completed", "run_failed", "run_cancelled",
    ];
    for (const type of eventTypes) {
      es.addEventListener(type, (ev) => {
        try {
          const event = JSON.parse((ev as MessageEvent).data) as TeamEvent;
          setEvents((prev) => {
            // 去重（replay 与实时可能重叠）
            if (prev.some((e) => e.sequence === event.sequence)) return prev;
            return [...prev, event];
          });
        } catch { /* ignore */ }
      });
    }
  }, []);

  const startRun = useCallback(
    async (task: string, startAgentId?: string): Promise<string> => {
      const res = await fetch(`/api/teams/${encodeURIComponent(sessionId)}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, agentId: startAgentId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error ?? `run start failed: ${res.status}`);
      }
      const { runId } = (await res.json()) as { runId: string };
      subscribeRun(runId);
      // 刷新运行历史
      void load();
      return runId;
    },
    [sessionId, subscribeRun, load],
  );

  const cancelRun = useCallback(async () => {
    if (!activeRunId) return;
    await fetch(`/api/teams/runs/${activeRunId}/cancel`, { method: "POST" }).catch(() => undefined);
  }, [activeRunId]);

  const steer = useCallback(
    async (content: string, agentId?: string) => {
      if (!activeRunId) return;
      const res = await fetch(`/api/teams/runs/${activeRunId}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, agentId }),
      });
      if (!res.ok) throw new Error("steer failed");
    },
    [activeRunId],
  );

  useEffect(() => () => esRef.current?.close(), []);

  return {
    team,
    chatMessages,
    runs,
    activeRunId,
    run,
    projections,
    events,
    connected,
    loading,
    error,
    load,
    startRun,
    cancelRun,
    steer,
  };
}

function useMemoProjections(events: TeamEvent[]): Projections {
  const [projections, setProjections] = useState<Projections>(() => reduce([]));
  useEffect(() => {
    setProjections(reduce(events));
  }, [events]);
  return projections;
}

export type { AgentExecution, TeamMessage, TeamRun, TeamTask };
