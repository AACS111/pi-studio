/**
 * RunReplayModal —— 单次运行（run）的执行回放弹窗（P2 执行回放 UI）。
 *
 * 两个视图：
 *  - 时间轴回放：按事件序列逐步重现（播放/暂停/倍速/拖动进度条），像「录像带」一样
 *    重看角色接力过程：任务创建 → 谁开始执行 → 输出/交接 → 任务完成/失败 → 收尾。
 *  - 任务 DAG：按 dependsOn 最长路径分层展示任务依赖图（列=并行波次），每张任务卡
 *    显示状态/角色/重试次数，连线表达依赖关系。
 *
 * 弹窗统一用 DraggableResizableModal（顶栏拖动 + 四边四角缩放）。
 * 数据源：GET /api/teams/runs/:runId（run + 投影 + 事件流，历史 run 与进行中 run 均可）。
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { DraggableResizableModal } from "./DraggableResizableModal";
import { MarkdownBody } from "./MarkdownBody";
import { resolveFilePath } from "@/lib/file-paths";
import { computeDagLayers, dagStatusColor, dagStatusIcon } from "@/lib/team/dag-layers";
import type { AgentExecution, ArtifactRef, Decision, Projections, TeamDef, TeamEvent, TeamRun } from "@/lib/team/types";

interface Props {
  sessionId: string;
  runId: string;
  onClose: () => void;
  onOpenFile?: (path: string) => void;
}

type ReplayItem =
  | { kind: "run_start"; seq: number; ts: number; task: string }
  | { kind: "task_created"; seq: number; ts: number; title: string; taskId: string; agentId: string; deps: string[] }
  | { kind: "task_done"; seq: number; ts: number; taskId: string; ok: boolean; note?: string }
  | { kind: "exec_start"; seq: number; ts: number; execution: AgentExecution }
  | { kind: "exec_done"; seq: number; ts: number; executionId: string; agentId: string; status: string; failureReason?: string; thinkingPath?: string; changedCount: number; tokens?: number; durationMs?: number }
  | { kind: "message"; seq: number; ts: number; msgKind: string; agentId?: string; role?: string; content: string }
  | { kind: "handoff"; seq: number; ts: number; from: string; to: string; reason?: string }
  | { kind: "decision"; seq: number; ts: number; decision: Decision }
  | { kind: "artifact"; seq: number; ts: number; artifact: ArtifactRef }
  | { kind: "run_end"; seq: number; ts: number; status: string; reason?: string };

/** 事件流 → 回放脚本（视觉项序列，按 sequence 单调） */
function buildReplayItems(events: TeamEvent[]): ReplayItem[] {
  const items: ReplayItem[] = [];
  const execStartAt = new Map<string, number>();
  const execAgent = new Map<string, string>();
  for (const e of events) {
    const seq = e.sequence;
    const ts = e.timestamp;
    switch (e.type) {
      case "run_started":
        items.push({ kind: "run_start", seq, ts, task: e.task });
        break;
      case "task_created":
        items.push({ kind: "task_created", seq, ts, title: e.task.title, taskId: e.task.id, agentId: e.task.assignedAgentId, deps: e.task.dependsOn ?? [] });
        break;
      case "task_completed":
        items.push({ kind: "task_done", seq, ts, taskId: e.taskId, ok: true });
        break;
      case "task_failed":
        items.push({ kind: "task_done", seq, ts, taskId: e.taskId, ok: false, note: e.reason });
        break;
      case "execution_started":
        execStartAt.set(e.execution.id, e.execution.startedAt);
        execAgent.set(e.execution.id, e.execution.agentId);
        items.push({ kind: "exec_start", seq, ts, execution: e.execution });
        break;
      case "execution_completed": {
        const startedAt = execStartAt.get(e.executionId);
        items.push({
          kind: "exec_done", seq, ts,
          executionId: e.executionId,
          agentId: execAgent.get(e.executionId) ?? "",
          status: e.status,
          failureReason: e.failureReason,
          thinkingPath: e.thinkingPath,
          changedCount: e.changedFiles?.length ?? 0,
          tokens: e.stats?.totalTokens,
          durationMs: startedAt ? e.timestamp - startedAt : undefined,
        });
        break;
      }
      case "message_created":
        if (e.message.kind === "user" || e.message.kind === "agent" || e.message.kind === "system" || e.message.kind === "handoff") {
          items.push({ kind: "message", seq, ts, msgKind: e.message.kind, agentId: e.message.agentId, role: e.message.role, content: e.message.content });
        }
        break;
      case "handoff_requested":
        items.push({ kind: "handoff", seq, ts, from: e.from, to: e.to, reason: e.reason });
        break;
      case "decision_recorded":
        items.push({ kind: "decision", seq, ts, decision: e.decision });
        break;
      case "artifact_produced":
        items.push({ kind: "artifact", seq, ts, artifact: e.artifact });
        break;
      case "approval_requested":
        items.push({ kind: "message", seq, ts, msgKind: "system", content: `🔒 人工审批请求：${e.from} → ${e.to}` });
        break;
      case "approval_resolved":
        items.push({ kind: "message", seq, ts, msgKind: "system", content: `${e.approved ? "✅ 审批已批准" : "⛔ 审批被驳回"}（${e.by}）` });
        break;
      case "steer":
        items.push({ kind: "message", seq, ts, msgKind: "user", content: `📣 介入：${e.content}` });
        break;
      case "run_completed":
      case "run_failed":
      case "run_cancelled":
        items.push({ kind: "run_end", seq, ts, status: e.type.replace("run_", ""), reason: `${e.statusReason.code} — ${e.statusReason.message}` });
        break;
      default:
        break; // agent_progress 等高频事件不进回放时间轴
    }
  }
  return items;
}

const AGENT_EMOJI_FALLBACK: Record<string, string> = { leader: "🧭", product: "📋", developer: "💻", tester: "🧪", researcher: "🔍", writer: "📝" };

function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

export function RunReplayModal({ sessionId, runId, onClose, onOpenFile }: Props) {
  const { t } = useI18n();
  const [team, setTeam] = useState<TeamDef | null>(null);
  const [run, setRun] = useState<TeamRun | null>(null);
  const [projections, setProjections] = useState<Projections | null>(null);
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"timeline" | "dag">("timeline");

  // —— 回放状态 ——
  const [cursor, setCursor] = useState(0);           // 已揭示的项数（0..items.length）
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const listRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detailRes, teamRes] = await Promise.all([
        fetch(`/api/teams/runs/${runId}`),
        fetch(`/api/teams/${encodeURIComponent(sessionId)}`),
      ]);
      if (!detailRes.ok) throw new Error(`run load failed: ${detailRes.status}`);
      const detail = await detailRes.json();
      setRun(detail.run ?? null);
      setProjections(detail.projections ?? null);
      setEvents(detail.events ?? []);
      if (teamRes.ok) {
        const teamData = await teamRes.json();
        setTeam(teamData.team ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [runId, sessionId]);

  useEffect(() => {
    setCursor(0);
    setPlaying(false);
    void load();
  }, [load]);

  const items = useMemo(() => buildReplayItems(events), [events]);

  // 重置到「全部展示」：首次加载直接呈现完整结果，播放按钮提供从头回放体验
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (loading || initialized || items.length === 0) return;
    setCursor(items.length);
    setInitialized(true);
  }, [loading, initialized, items.length]);

  // 播放：定时推进游标（每项 900/speed 毫秒）
  useEffect(() => {
    if (!playing) return;
    if (cursor >= items.length) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setCursor((c) => Math.min(c + 1, items.length)), 900 / speed);
    return () => clearTimeout(timer);
  }, [playing, cursor, speed, items.length]);

  // 播放时自动滚动到底部（用户手动拖进度/滚动时不打断）
  useEffect(() => {
    if (!playing) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [cursor, playing]);

  const agentInfo = useCallback((agentId?: string) => {
    if (!agentId) return { emoji: "🤖", name: "" };
    const a = team?.agents.find((x) => x.id === agentId);
    return { emoji: a?.emoji ?? AGENT_EMOJI_FALLBACK[agentId] ?? "🤖", name: a?.name ?? agentId };
  }, [team]);

  const handlePlay = () => {
    if (cursor >= items.length) setCursor(0); // 从头回放
    setPlaying((p) => !p);
  };

  const statusChip = (status: string) => ({
    fontSize: 10,
    padding: "1px 8px",
    borderRadius: "var(--radius-sm)",
    fontWeight: 600,
    color: "#fff",
    background: status === "completed" ? "#2ec27e" : status === "cancelled" ? "#9898a0" : status === "running" ? "var(--accent)" : status === "pending" ? "#8a8a95" : "#e5484d",
  });

  const cwd = team?.cwd;

  return (
    <DraggableResizableModal
      title={`🎬 ${t("team.replay.title")}`}
      hint={t("team.resizeHint")}
      onClose={onClose}
      width={980}
      height={660}
    >
      {/* 运行概要条 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        {run ? (
          <>
            <span style={{ fontWeight: 600, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 380 }} title={run.task}>{run.task}</span>
            <span style={statusChip(run.status)}>{run.status}</span>
            {run.statusReason && (
              <span style={{ fontSize: 10.5, color: "var(--text-muted)" }} title={run.statusReason.message}>
                {run.statusReason.code}
              </span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: 10, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              <span title={t("team.tokenTooltip")}>⚡ {run.stats.tokensUsed.toLocaleString("zh-CN")} tok</span>
              <span>hops {run.stats.hopCount}</span>
              <span>execs {run.stats.agentExecutions}</span>
              {run.stats.durationMs > 0 && <span>{fmtDuration(run.stats.durationMs)}</span>}
              <span>{fmtTime(run.createdAt)}</span>
            </span>
            <button onClick={() => void load()} title={t("team.replay.refresh")} style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: 12, padding: "2px 8px", color: "var(--text-muted)" }}>🔄</button>
          </>
        ) : (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{loading ? "…" : t("team.replay.noEvents")}</span>
        )}
      </div>

      {/* Tab 切换 */}
      <div style={{ display: "flex", gap: 4, padding: "8px 8px 0", flexShrink: 0 }}>
        {([
          ["timeline", `▶ ${t("team.replay.tabTimeline")}`],
          ["dag", `🕸 ${t("team.replay.tabDag")}`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              border: "1px solid var(--border)",
              borderBottom: tab === key ? "none" : "1px solid var(--border)",
              borderRadius: "8px 8px 0 0",
              background: tab === key ? "var(--bg-soft, rgba(0,0,0,0.03))" : "transparent",
              color: tab === key ? "var(--text)" : "var(--text-muted)",
              fontSize: 12,
              padding: "5px 14px",
              cursor: "pointer",
              fontWeight: tab === key ? 600 : 400,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div style={{ padding: "8px 12px", color: "#e5484d", fontSize: 12 }}>⚠️ {error}</div>}

      {/* —— 时间轴回放 —— */}
      {tab === "timeline" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* 播放控制条 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", flexShrink: 0, borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
            <button
              onClick={handlePlay}
              disabled={items.length === 0}
              title={playing ? t("team.replay.pause") : t("team.replay.play")}
              style={{
                width: 34, height: 34, borderRadius: "50%", border: "1px solid var(--accent)", background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                color: "var(--accent)", fontSize: 14, cursor: items.length ? "pointer" : "not-allowed", display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              {playing ? "⏸" : cursor >= items.length && items.length > 0 ? "↻" : "▶"}
            </button>
            <button
              onClick={() => { setPlaying(false); setCursor(0); }}
              disabled={items.length === 0}
              title={t("team.replay.restart")}
              style={{ background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: 12, padding: "4px 10px", color: "var(--text-muted)" }}
            >
              ⏮ {t("team.replay.restart")}
            </button>
            <select
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              title={t("team.replay.speed")}
              style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontSize: 11.5, padding: "4px 6px", cursor: "pointer" }}
            >
              {[1, 2, 4, 8].map((s) => (
                <option key={s} value={s}>{s}×</option>
              ))}
            </select>
            <input
              type="range"
              min={0}
              max={items.length}
              value={cursor}
              onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }}
              style={{ flex: 1, accentColor: "var(--accent)", cursor: "pointer" }}
              aria-label={t("team.replay.progress")}
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
              {cursor} / {items.length}
            </span>
          </div>

          {/* 时间轴列表 */}
          <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
            {items.length === 0 && !loading && (
              <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 12, padding: 24 }}>{t("team.replay.noEvents")}</div>
            )}
            {items.slice(0, cursor).map((item) => (
              <ReplayRow key={item.seq} item={item} agentInfo={agentInfo} cwd={cwd} onOpenFile={onOpenFile} thinkingLabel={t("team.replay.thinkingFile")} />
            ))}
          </div>
        </div>
      )}

      {/* —— 任务 DAG —— */}
      {tab === "dag" && <DagView projections={projections} team={team} onOpenFile={onOpenFile} cwd={cwd} noTasksLabel={t("team.replay.noTasks")} agentLabel={t("team.replay.agent")} retryLabel={t("team.replay.retryCount")} depsLabel={t("team.replay.deps")} />}
    </DraggableResizableModal>
  );
}

/** 时间轴单行 */
function ReplayRow({ item, agentInfo, cwd, onOpenFile, thinkingLabel }: {
  item: ReplayItem;
  agentInfo: (id?: string) => { emoji: string; name: string };
  cwd?: string;
  onOpenFile?: (p: string) => void;
  thinkingLabel: string;
}) {
  const time = <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", flexShrink: 0, width: 62, textAlign: "right" }}>{fmtTime(item.ts)}</span>;

  switch (item.kind) {
    case "run_start":
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {time}
          <span>🚀</span>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>任务发布<div style={{ fontWeight: 400, fontSize: 12, color: "var(--text-muted)", marginTop: 2, whiteSpace: "pre-wrap" }}>{item.task.slice(0, 400)}</div></div>
        </div>
      );
    case "task_created": {
      const { emoji, name } = agentInfo(item.agentId);
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {time}
          <span>📋</span>
          <div style={{ fontSize: 12 }}>
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{item.taskId}</span>{" "}
            {item.title} → <span title={item.agentId}>{emoji} {name}</span>
            {item.deps.length > 0 && <span style={{ color: "var(--text-dim)" }}>（←{item.deps.join(",")}）</span>}
          </div>
        </div>
      );
    }
    case "task_done":
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {time}
          <span>{item.ok ? "✅" : "❌"}</span>
          <div style={{ fontSize: 12, color: item.ok ? "var(--text-muted)" : "#e5484d" }}>
            任务 {item.taskId} {item.ok ? "完成" : "失败"}{item.note ? `：${item.note.slice(0, 200)}` : ""}
          </div>
        </div>
      );
    case "exec_start": {
      const { emoji, name } = agentInfo(item.execution.agentId);
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "center", opacity: 0.75 }}>
          {time}
          <span style={{ fontSize: 10 }}>▶</span>
          <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{emoji} {name}#{item.execution.sequence} 开始执行</span>
        </div>
      );
    }
    case "exec_done": {
      const { emoji, name } = agentInfo(item.agentId);
      const ok = item.status === "completed";
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {time}
          <span>{ok ? "🏁" : "⚠️"}</span>
          <div style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span style={{ fontWeight: 600 }}>{emoji} {name}</span>
            <span style={{
              fontSize: 10, padding: "1px 7px", borderRadius: "var(--radius-sm)", fontWeight: 600,
              color: ok ? "#2ec27e" : item.status === "cancelled" ? "#9898a0" : "#e5484d",
              border: `1px solid ${ok ? "rgba(46,194,125,0.4)" : item.status === "cancelled" ? "rgba(152,152,160,0.4)" : "rgba(229,72,77,0.4)"}`,
            }}>{item.status}</span>
            {item.durationMs !== undefined && <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>⏱ {fmtDuration(item.durationMs)}</span>}
            {item.tokens !== undefined && <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>⚡ {item.tokens.toLocaleString("zh-CN")} tok</span>}
            {item.changedCount > 0 && <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>📝 {item.changedCount} 文件</span>}
            {item.failureReason && <span style={{ color: "#e5484d", fontSize: 11.5 }}>：{item.failureReason.slice(0, 200)}</span>}
            {item.thinkingPath && onOpenFile && (
              <button onClick={() => onOpenFile(item.thinkingPath!)} title={item.thinkingPath} style={linkBtn}>{thinkingLabel}</button>
            )}
          </div>
        </div>
      );
    }
    case "message": {
      if (item.msgKind === "system") {
        return (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            {time}
            <span>ℹ️</span>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", whiteSpace: "pre-wrap" }}>{item.content}</div>
          </div>
        );
      }
      const { emoji, name } = agentInfo(item.agentId);
      const isUser = item.msgKind === "user";
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {time}
          {isUser ? <span>👤</span> : <span>{emoji}</span>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 2, color: isUser ? "var(--accent)" : "var(--text)" }}>{isUser ? "用户" : item.role || name}</div>
            <div className="markdown-team-message" style={{ fontSize: 12.5, lineHeight: 1.55, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "7px 10px", background: isUser ? "color-mix(in srgb, var(--accent) 7%, transparent)" : "var(--bg-soft, rgba(0,0,0,0.02))" }}>
              <MarkdownBody cwd={cwd}>{item.content.length > 4000 ? `${item.content.slice(0, 4000)}…` : item.content}</MarkdownBody>
            </div>
          </div>
        </div>
      );
    }
    case "handoff":
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {time}
          <span>🔁</span>
          <div style={{ fontSize: 11.5, color: "var(--accent)" }}>
            {item.from} → {item.to === "__end__" ? "🏁 结束" : item.to}
            {item.reason && <span style={{ color: "var(--text-muted)" }}>（{item.reason.slice(0, 120)}）</span>}
          </div>
        </div>
      );
    case "decision": {
      const verdict = item.decision.verdict;
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {time}
          <span>🧭</span>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
            [{item.decision.madeBy}] {item.decision.content.slice(0, 220)}
            {verdict && (
              <span style={{
                marginLeft: 6, fontSize: 10, fontWeight: 600,
                color: verdict === "pass" ? "#2ec27e" : verdict === "fail" ? "#e5484d" : "var(--text-muted)",
              }}>【{verdict === "pass" ? "通过" : verdict === "fail" ? "失败" : "参考"}】</span>
            )}
          </div>
        </div>
      );
    }
    case "artifact":
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {time}
          <span>📎</span>
          {onOpenFile ? (
            <button onClick={() => onOpenFile?.(resolveFilePath(item.artifact.path, cwd))} title={item.artifact.path} style={linkBtn}>{item.artifact.path}</button>
          ) : (
            <span style={{ fontSize: 11.5, fontFamily: "var(--font-mono)" }}>{item.artifact.path}</span>
          )}
        </div>
      );
    case "run_end":
      return (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 4, padding: "8px 10px", borderRadius: "var(--radius-md)", background: "var(--bg-soft, rgba(0,0,0,0.03))", border: "1px dashed var(--border)" }}>
          {time}
          <span>{item.status === "completed" ? "🏁" : item.status === "cancelled" ? "⏹️" : "💀"}</span>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            运行{item.status === "completed" ? "完成" : item.status === "cancelled" ? "已取消" : "失败"}
            {item.reason && <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>：{item.reason}</span>}
          </div>
        </div>
      );
    default:
      return null;
  }
}

const linkBtn: CSSProperties = {
  background: "transparent", border: "none", color: "var(--accent)", cursor: "pointer",
  fontSize: 11, padding: 0, textDecoration: "underline", textUnderlineOffset: 2, wordBreak: "break-all", textAlign: "left",
};

/** 任务 DAG 分层视图（列 = 依赖层/并行波次；SVG 贝塞尔连线） */
function DagView({ projections, team, onOpenFile, cwd, noTasksLabel, agentLabel, retryLabel, depsLabel }: {
  projections: Projections | null;
  team: TeamDef | null;
  onOpenFile?: (p: string) => void;
  cwd?: string;
  noTasksLabel: string;
  agentLabel: string;
  retryLabel: string;
  depsLabel: string;
}) {
  const tasks = useMemo(() => {
    const all = projections?.tasks ?? [];
    // 排除 runtime 根任务（TASK-001「用户发布的任务」），只展示计划/子任务
    return all.filter((t) => !(t.createdBy === "runtime" && t.title === all.find((x) => x.id === "TASK-001")?.title));
  }, [projections]);

  const { layers } = useMemo(() => computeDagLayers(tasks), [tasks]);

  const agentName = useCallback((id: string) => {
    const a = team?.agents.find((x) => x.id === id);
    return a ? `${a.emoji ?? "🤖"} ${a.name}` : id;
  }, [team]);

  if (tasks.length === 0) {
    return <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12.5 }}>{noTasksLabel}</div>;
  }

  const CARD_W = 232;
  const CARD_H = 92;
  const GAP_X = 56;
  const GAP_Y = 14;
  const PAD = 20;

  // 卡片坐标：列=层，行=层内序
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((layerIds, li) => {
    layerIds.forEach((id, ri) => {
      pos.set(id, { x: PAD + li * (CARD_W + GAP_X), y: PAD + ri * (CARD_H + GAP_Y) });
    });
  });
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const width = PAD * 2 + Math.max(0, layers.length - 1) * (CARD_W + GAP_X) + CARD_W;
  const maxRows = Math.max(...layers.map((l) => l.length), 1);
  const height = PAD * 2 + maxRows * (CARD_H + GAP_Y) - GAP_Y;

  // 连线：依赖卡片右缘中点 → 目标卡片左缘中点
  const edges: Array<{ d: string; failed: boolean }> = [];
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      const from = pos.get(dep);
      const to = pos.get(task.id);
      if (!from || !to) continue;
      const x1 = from.x + CARD_W;
      const y1 = from.y + CARD_H / 2;
      const x2 = to.x;
      const y2 = to.y + CARD_H / 2;
      const mx = (x1 + x2) / 2;
      edges.push({ d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, failed: taskById.get(dep)?.status === "failed" });
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg-soft, rgba(0,0,0,0.015))" }}>
      <div style={{ position: "relative", width, height, minWidth: "100%" }}>
        <svg width={width} height={height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <defs>
            <marker id="dag-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="var(--border)" />
            </marker>
          </defs>
          {edges.map((e, i) => (
            <path key={i} d={e.d} fill="none" stroke={e.failed ? "rgba(229,72,77,0.55)" : "var(--border)"} strokeWidth={1.6} markerEnd="url(#dag-arrow)" />
          ))}
        </svg>
        {tasks.map((task) => {
          const p = pos.get(task.id);
          if (!p) return null;
          const color = dagStatusColor(task.status);
          const isRoot = task.createdBy === "runtime";
          return (
            <div
              key={task.id}
              title={`${task.title}${task.description ? `\n${task.description}` : ""}`}
              style={{
                position: "absolute", left: p.x, top: p.y, width: CARD_W, height: CARD_H,
                background: "var(--bg)", border: `1.5px solid ${color}`, borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-md)", padding: "8px 10px", boxSizing: "border-box",
                display: "flex", flexDirection: "column", gap: 4, overflow: "hidden",
                opacity: task.status === "cancelled" ? 0.55 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span style={{ fontSize: 12 }}>{dagStatusIcon(task.status)}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", flexShrink: 0 }}>{task.planTaskId ?? task.id}</span>
                {task.retries ? <span title={retryLabel} style={{ fontSize: 9.5, color: "#f59e0b", fontWeight: 600 }}>🔁{task.retries}</span> : null}
                <span style={{ marginLeft: "auto", fontSize: 9.5, fontWeight: 700, color, flexShrink: 0 }}>{task.status}</span>
              </div>
              <div style={{ fontSize: 11.8, fontWeight: 600, lineHeight: 1.35, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{isRoot ? "🏁 " : ""}{task.title}</div>
              <div style={{ marginTop: "auto", display: "flex", gap: 6, alignItems: "center", fontSize: 10, color: "var(--text-muted)", overflow: "hidden" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agentLabel}: {agentName(task.assignedAgentId)}</span>
                {task.dependsOn && task.dependsOn.length > 0 && (
                  <span style={{ flexShrink: 0 }} title={`${depsLabel}: ${task.dependsOn.join(", ")}`}>←{task.dependsOn.map((d) => taskById.get(d)?.planTaskId ?? d).join(",")}</span>
                )}
              </div>
              {task.completedAt && task.startedAt && (
                <div style={{ fontSize: 9.5, color: "var(--text-dim)" }}>⏱ {fmtDuration(task.completedAt - task.startedAt)}</div>
              )}
            </div>
          );
        })}
      </div>
      {/* 图例 */}
      <div style={{ display: "flex", gap: 14, padding: "10px 16px", fontSize: 10.5, color: "var(--text-muted)", flexWrap: "wrap" }}>
        {(["pending", "running", "completed", "failed", "cancelled"] as const).map((s) => (
          <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: dagStatusColor(s), display: "inline-block" }} />
            {dagStatusIcon(s)} {s}
          </span>
        ))}
      </div>
      {onOpenFile && cwd && (projections?.artifacts.length ?? 0) > 0 && (
        <div style={{ padding: "0 16px 12px", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>📎：</span>
          {projections!.artifacts.slice(0, 8).map((a) => (
            <button key={a.id} onClick={() => onOpenFile?.(resolveFilePath(a.path, cwd))} title={a.description ?? a.path} style={linkBtn}>{a.path}</button>
          ))}
        </div>
      )}
    </div>
  );
}
