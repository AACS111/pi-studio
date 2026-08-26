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
  ExecutionMode,
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

/** 某次角色执行的实时进度（thinking 摘要 / 工具调用） */
export interface ExecutionProgress {
  executionId: string;
  agentId: string;
  kind: "thinking" | "tool";
  content: string;
  timestamp: number;
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
  /** 实时进度（thinking/工具调用，按出现顺序） */
  progress: ExecutionProgress[];
  connected: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  startRun: (task: string, startAgentId?: string, mode?: ExecutionMode) => Promise<string>;
  cancelRun: () => Promise<void>;
  steer: (content: string, agentId?: string) => Promise<void>;
  /** P1-2：批准/驳回当前等待审批的 transition */
  approveRun: () => Promise<void>;
  rejectRun: () => Promise<void>;
}

export function useTeamRun(sessionId: string): TeamChatData {
  const [team, setTeam] = useState<TeamDef | null>(null);
  const [chatMessages, setChatMessages] = useState<TeamMessage[]>([]);
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [run, setRun] = useState<TeamRun | null>(null);
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [progress, setProgress] = useState<ExecutionProgress[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // 已订阅的 run id：load() 重载时避免反复重开同一 run 的 SSE。
  const subscribedRunIdRef = useRef<string | null>(null);

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
    if (subscribedRunIdRef.current === runId) return;
    esRef.current?.close();
    setEvents([]);
    setProgress([]);
    setActiveRunId(runId);
    setConnected(false);
    subscribedRunIdRef.current = runId;

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
    // 实时进度事件：单独收集（不污染事件流数组；重复帧去重）
    es.addEventListener("agent_progress", (ev) => {
      try {
        const event = JSON.parse((ev as MessageEvent).data) as TeamEvent & { kind: "thinking" | "tool"; content: string; executionId: string; agentId: string; timestamp: number };
        setProgress((prev) => {
          if (prev.some((p) => p.executionId === event.executionId && p.timestamp === event.timestamp)) return prev;
          return [...prev, { executionId: event.executionId, agentId: event.agentId, kind: event.kind, content: event.content, timestamp: event.timestamp }];
        });
      } catch { /* ignore */ }
    });
  }, []);

  const startRun = useCallback(
    async (task: string, startAgentId?: string, mode?: ExecutionMode): Promise<string> => {
      const res = await fetch(`/api/teams/${encodeURIComponent(sessionId)}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, agentId: startAgentId, mode }),
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

  const approveRun = useCallback(async () => {
    if (!activeRunId) return;
    await fetch(`/api/teams/runs/${activeRunId}/approve`, { method: "POST" }).catch(() => undefined);
  }, [activeRunId]);

  const rejectRun = useCallback(async () => {
    if (!activeRunId) return;
    await fetch(`/api/teams/runs/${activeRunId}/reject`, { method: "POST" }).catch(() => undefined);
  }, [activeRunId]);

  useEffect(() => () => esRef.current?.close(), []);

  // 关键修复：加载历史后自动订阅最近一次 run（列表已按 createdAt 倒序），
  // 这样「切换项目组会话 / 重启应用(打包 exe)」后，已有 run 的执行结果与实时进度
  // 仍能被投影渲染出来 —— 否则只有刚 startRun 的 run 才有输出，历史完全不可见。
  useEffect(() => {
    if (!runs.length) return;
    const latest = runs[0];
    // 已订阅同一 run 就跳过（startRun 会显式订阅新 run，这里不打断）
    if (subscribedRunIdRef.current === latest.id) return;
    subscribeRun(latest.id);
  }, [runs, subscribeRun]);

  return {
    team,
    chatMessages,
    runs,
    activeRunId,
    run,
    projections,
    events,
    progress,
    connected,
    loading,
    error,
    load,
    startRun,
    cancelRun,
    steer,
    approveRun,
    rejectRun,
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
