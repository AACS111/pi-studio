/**
 * TeamChat —— 项目组主视图（Phase 1B）。
 * 群聊消息流（user/agent/system/handoff/imported）+ 任务发布 + 运行状态 + 历史。
 */
"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTeamRun } from "@/hooks/useTeamRun";
import { TeamSettings } from "./TeamSettings";
import { buildAtInsertText, extractAtQuery, type FileIndexEntry } from "@/lib/file-fuzzy";
import type { SkillInfo } from "@/lib/api-types";
import type { TeamMessage } from "@/lib/team/types";

interface Props {
  sessionId: string;
  teamName?: string;
  onOpenFile?: (path: string) => void;
}

const ROLE_EMOJI: Record<string, string> = {
  leader: "🧭",
  product: "📋",
  developer: "💻",
  tester: "🧪",
  researcher: "🔍",
  writer: "📝",
  assistant: "🤖",
};

/** 输入提示菜单项 */
interface AcItem {
  key: string;
  type: "agent" | "file" | "skill";
  icon: string;
  label: string;
  sub: string;
}

interface AcState {
  kind: "at" | "slash";
  start: number;
  query: string;
  items: AcItem[];
  active: number;
}

export function TeamChat({ sessionId, teamName, onOpenFile }: Props) {
  const { t } = useI18n();
  const data = useTeamRun(sessionId);
  const [task, setTask] = useState("");
  const [steerText, setSteerText] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsAgentId, setSettingsAgentId] = useState<string | undefined>(undefined);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const taskRef = useRef<HTMLTextAreaElement | null>(null);
  // —— 输入提示（@ 角色/文件、/ skill）——
  const [ac, setAc] = useState<AcState | null>(null);
  const acRef = useRef<AcState | null>(null);
  const fileIndexCache = useRef<Record<string, FileIndexEntry[]>>({});
  const fileIndexTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void data.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data.projections.messages.length, data.chatMessages.length]);

  const allMessages = useMemo(() => {
    const merged = [...data.chatMessages, ...data.projections.messages];
    // 把每次 run 的发起任务作为一条 user 消息（等同普通会话的“用户发送”），与消息流按时间交错
    const runStarts: TeamMessage[] = (data.runs ?? []).map((r) => ({
      id: `task-user-${r.id}`,
      kind: "user",
      content: r.task,
      createdAt: r.createdAt,
    }));
    // 当前活跃 run（尚未进入 runs 列表）也补一条发起消息
    if (data.run && typeof data.run.task === "string" && !data.runs.some((r) => r.id === data.activeRunId)) {
      runStarts.push({
        id: `task-user-active-${data.activeRunId}`,
        kind: "user",
        content: data.run.task,
        createdAt: data.run.createdAt,
      });
    }
    return [...merged, ...runStarts].sort((a, b) => a.createdAt - b.createdAt);
  }, [data.chatMessages, data.projections.messages, data.runs, data.run, data.activeRunId]);

  // run 状态查询表：task-user 消息 id → (status, task)，气泡里显示状态小标
  const runStatusMap = useMemo(() => {
    const map: Record<string, { status: string; task: string; createdAt: number }> = {};
    for (const r of data.runs ?? []) map[`task-user-${r.id}`] = { status: r.status, task: r.task, createdAt: r.createdAt };
    if (
      data.run &&
      typeof data.run.task === "string" &&
      !data.runs.some((rr) => rr.id === data.activeRunId)
    ) {
      map[`task-user-active-${data.activeRunId}`] = { status: data.run.status, task: data.run.task, createdAt: data.run.createdAt };
    }
    return map;
  }, [data.runs, data.run, data.activeRunId]);

  const handlePost = async () => {
    const text = task.trim();
    if (!text || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      // 起始角色固定 = 项目组设置的入口角色（entryAgentId），不再在对话窗口重复选择
      await data.startRun(text);
      setTask("");
    } catch (e) {
      setPostError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  };

  const handleSteer = async () => {
    const text = steerText.trim();
    if (!text) return;
    try {
      await data.steer(text);
      setSteerText("");
    } catch {
      setPostError("steer failed");
    }
  };

  // —— 输入提示逻辑 ——
  const setAcState = (s: AcState | null) => {
    setAc(s);
    acRef.current = s;
  };

  const loadSkills = async () => {
    if (skills) return;
    try {
      const cwd = data.team?.cwd;
      if (!cwd) return;
      const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
      if (!res.ok) return;
      const d = (await res.json()) as { skills?: SkillInfo[] };
      setSkills(d.skills ?? []);
    } catch {
      /* ignore */
    }
  };

  /** @ 菜单：角色（匹配 name/role/emoji）+ 文件（file-index，立即拉取） */
  const buildAtMenu = (query: string, start: number) => {
    const agents = data.team?.agents ?? [];
    const q = query.toLowerCase();
    const agentItems: AcItem[] = agents
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q) || (a.emoji ?? "").includes(query))
      .map((a) => ({
        key: `agent-${a.id}`,
        type: "agent" as const,
        icon: a.emoji ?? ROLE_EMOJI[a.id] ?? "🤖",
        label: a.name,
        sub: a.role,
      }));

    // 立即出角色菜单（文件异步合并，失败不影响）
    setAcState({ kind: "at", start, query, items: agentItems.slice(0, 20), active: 0 });

    // 文件：立即拉取（带缓存）
    const cwd = data.team?.cwd;
    if (cwd) {
      if (fileIndexTimer.current) clearTimeout(fileIndexTimer.current);
      fileIndexTimer.current = setTimeout(async () => {
        try {
          const cached = fileIndexCache.current[cwd];
          if (cached && query === "") {
            const fileItems: AcItem[] = cached.map((m) => ({
              key: `file-${m.path}`,
              type: "file" as const,
              icon: m.isDir ? "📁" : "📄",
              label: m.path,
              sub: m.isDir ? "directory" : "file",
            }));
            setAcState({ kind: "at", start, query, items: [...agentItems, ...fileItems].slice(0, 20), active: 0 });
            return;
          }
          const res = await fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`);
          if (!res.ok) return;
          const d = (await res.json()) as { matches?: FileIndexEntry[] };
          const matches = d.matches ?? [];
          fileIndexCache.current[cwd] = matches;
          const fileItems: AcItem[] = matches.map((m) => ({
            key: `file-${m.path}`,
            type: "file" as const,
            icon: m.isDir ? "📁" : "📄",
            label: m.path,
            sub: m.isDir ? "directory" : "file",
          }));
          setAcState({ kind: "at", start, query, items: [...agentItems, ...fileItems].slice(0, 20), active: 0 });
        } catch {
          /* 文件拉取失败：保留角色菜单 */
        }
      }, 60);
    }
  };

  /** / 菜单：skill 列表（空态提示 + 加载完成后自动刷新） */
  const buildSlashMenu = (query: string, start: number) => {
    void loadSkills();
    const q = query.toLowerCase();
    const items: AcItem[] = (skills ?? [])
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .map((s) => ({ key: `skill-${s.name}`, type: "skill" as const, icon: "🧩", label: s.name, sub: s.description }));
    setAcState({ kind: "slash", start, query, items: items.slice(0, 20), active: 0 });
  };

  // skills 加载完成后若 / 菜单仍开，自动刷新
  useEffect(() => {
    const state = acRef.current;
    if (state?.kind === "slash") {
      buildSlashMenu(state.query, state.start);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills]);

  /** 输入变化时检测 @ // 并构建菜单 */
  const updateAutocomplete = (value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const at = extractAtQuery(before);
    const slash = /(?:^|\n)\/([^\s/]*)$/.exec(before);
    if (at) {
      buildAtMenu(at.query, at.start);
    } else if (slash) {
      buildSlashMenu(slash[1], cursor - slash[0].length);
    } else {
      if (fileIndexTimer.current) clearTimeout(fileIndexTimer.current);
      setAcState(null);
    }
  };

  /** 应用选中项：替换 token */
  const applyAc = (item: AcItem) => {
    const state = acRef.current;
    const el = taskRef.current;
    if (!state || !el) return;
    const cursor = el.selectionStart ?? task.length;
    const before = task.slice(0, state.start);
    const after = task.slice(cursor);
    let insert = "";
    let caret = 0;
    if (item.type === "agent") {
      insert = `@${item.label} `;
      caret = insert.length;
    } else if (item.type === "file") {
      const r = buildAtInsertText(item.label, item.sub === "directory");
      insert = r.text;
      caret = r.cursorOffset;
    } else {
      insert = `skill:${item.label} `;
      caret = insert.length;
    }
    const newValue = before + insert + after;
    setTask(newValue);
    setAcState(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length + caret, before.length + caret);
    });
  };

  /** 输入区按键：菜单导航 + Enter/Ctrl+Enter 发送 */
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const state = acRef.current;
    if (state && state.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcState({ ...state, active: (state.active + 1) % state.items.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcState({ ...state, active: (state.active - 1 + state.items.length) % state.items.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyAc(state.items[state.active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAcState(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      void handlePost();
    }
  };

  const runStatus = data.run;
  const running = runStatus?.status === "running" || runStatus?.status === "pending";
  const statusReason = runStatus?.statusReason;

  // 当前正在执行的角色（从 executions 投影找最后一个 running）
  const currentExecuting = (() => {
    if (!running) return null;
    const teamAgents = data.team?.agents ?? [];
    const execs = data.projections?.executions ?? [];
    for (let i = execs.length - 1; i >= 0; i--) {
      const e = execs[i];
      if (e.status === "running") {
        const agent = teamAgents.find((a) => a.id === e.agentId);
        return {
          emoji: agent?.emoji ?? ROLE_EMOJI[e.agentId] ?? "🤖",
          name: agent?.name ?? e.agentId,
          seq: e.sequence,
        };
      }
    }
    return null;
  })();

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 18 }}>👥</span>
          {editingName ? (
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => setEditingName(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void (async () => {
                    const name = nameDraft.trim();
                    setEditingName(false);
                    if (name) {
                      try {
                        await fetch(`/api/teams/${sessionId}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ name }),
                        });
                        void data.load();
                      } catch {
                        /* ignore */
                      }
                    }
                  })();
                }
                if (e.key === "Escape") setEditingName(false);
              }}
              style={{
                fontWeight: 600, fontSize: 14, border: "1px solid var(--accent)", borderRadius: 6,
                padding: "2px 8px", background: "var(--bg)", color: "var(--text)", outline: "none", maxWidth: 260,
              }}
            />
          ) : (
            <button
              onClick={() => {
                setNameDraft(data.team?.name ?? teamName ?? "");
                setEditingName(true);
              }}
              title={t("team.renameHint")}
              style={{
                fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                background: "none", border: "none", cursor: "pointer", color: "var(--text)", padding: 0, maxWidth: 260,
              }}
            >
              {data.team?.name ?? teamName ?? t("team.title")}
            </button>
          )}
          <span style={styles.badge}>{t("team.badge")}</span>
        </div>
        {data.team && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {(() => {
              const team = data.team;
              return team.agents.map((a) => (
                <span key={a.id} style={{ ...styles.agentChip, cursor: "pointer" }} title={`${t("team.settings.editAgent")}: ${a.name}`}>
                  <span
                    onClick={() => {
                      setSettingsAgentId(a.id);
                      setSettingsOpen(true);
                    }}
                  >
                    {a.emoji ?? ROLE_EMOJI[a.id] ?? "🤖"} {a.name}
                  </span>
                </span>
              ));
            })()}
            <span style={styles.modeChip}>{t(`team.routing.${data.team.defaultRoutingMode}`)}</span>
            <button
              onClick={() => setSettingsOpen(true)}
              style={styles.settingsBtn}
              title={t("team.settings.open")}
              aria-label={t("team.settings.open")}
            >
              ⚙️
            </button>
          </div>
        )}
      </div>

      {/* 消息区 */}
      <div style={styles.messages}>
        {allMessages.length === 0 && (
          <div style={styles.empty}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>👥</div>
            <div style={{ fontSize: 14, color: "var(--text)" }}>{t("team.empty")}</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{t("team.emptyHint")}</div>
          </div>
        )}
        {allMessages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            onOpenFile={onOpenFile}
            runStatusMap={runStatusMap}
          />
        ))}
        {running && (
          <div style={{ ...styles.systemLine }}>
            {currentExecuting ? (
              <span style={{ color: "var(--accent)" }}>
                ⏳ {currentExecuting.emoji}{" "}
                <b>{currentExecuting.name}</b>
                {currentExecuting.seq > 1 ? ` #${currentExecuting.seq}` : ""} {t("team.agentsWorking")}…
              </span>
            ) : (
              <span style={{ color: "var(--text-muted)" }}>⏳ {t("team.agentsWorking")}…</span>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {postError && <div style={styles.error}>{postError}</div>}

      {/* 输入区（与普通会话一致：单组合输入框 + 框内内联操作） */}
      <div style={styles.inputArea}>
        {/* 输入提示菜单 */}
        {ac && ac.items.length > 0 && (
          <div style={styles.acMenu}>
            {ac.items.map((item, i) => (
              <button
                key={item.key}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); applyAc(item); }}
                onMouseEnter={() => setAcState({ ...ac, active: i })}
                style={{
                  ...styles.acItem,
                  ...(i === ac.active ? { background: "var(--bg-hover, rgba(0,0,0,0.06))", color: "var(--text)" } : {}),
                }}
              >
                <span style={{ fontSize: 13, flexShrink: 0 }}>{item.icon}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
                <span style={{ fontSize: 10, color: "var(--text-dim)", maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.sub}</span>
              </button>
            ))}
          </div>
        )}

        <div style={styles.composer}>
          <div style={styles.composerRow}>
            <textarea
              ref={taskRef}
              value={task}
              onChange={(e) => {
                const v = e.target.value;
                setTask(v);
                updateAutocomplete(v, e.target.selectionStart ?? v.length);
              }}
              onKeyDown={handleInputKeyDown}
              placeholder={t("team.inputPlaceholder")}
              style={styles.composerTextarea}
            />
            {running ? (
              <button
                onClick={() => void data.cancelRun()}
                style={styles.btnDangerInline}
                title={t("team.cancel")}
                aria-label={t("team.cancel")}
              >
                ⏹
              </button>
            ) : (
              <button
                onClick={() => void handlePost()}
                disabled={posting || !task.trim()}
                style={styles.btnPrimaryInline}
                title={t("team.startRun")}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="2" y1="7" x2="11" y2="7" />
                  <polyline points="7.5 3 12 7 7.5 11" />
                </svg>
                {t("chat.send")}
              </button>
            )}
          </div>

          {running && (
            <div style={styles.composerSteer}>
              <input
                value={steerText}
                onChange={(e) => setSteerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSteer();
                }}
                placeholder={t("team.steerPlaceholder")}
                style={{ ...styles.steerInput, flex: 1 }}
              />
              <button onClick={() => void handleSteer()} style={styles.btnSecondary}>
                {t("team.steer")}
              </button>
            </div>
          )}
        </div>

        {/* 运行结果简档（仅非运行态简述；运行中的“谁在思考”显示在消息区底部） */}
        {((runStatus && !running) || data.connected) && (
          <div style={styles.runFooter}>
            {runStatus && !running && (
              <>
                <span>
                  {runStatus.status === "completed" ? "✅" : runStatus.status === "cancelled" ? "⏹️" : "❌"} {runStatus.status}
                </span>
                {statusReason && (
                  <span>{t("team.statusReason")}: {statusReason.code} — {statusReason.message}</span>
                )}
                <span style={{ marginLeft: "auto" }}>
                  hops {runStatus.stats.hopCount} / rework {runStatus.stats.reworkCount} / execs {runStatus.stats.agentExecutions}
                </span>
              </>
            )}
            {data.connected && <span style={{ fontSize: 11, color: "var(--accent)" }}>● {t("team.live")}</span>}
          </div>
        )}
      </div>

      {/* 项目组设置 */}
      {settingsOpen && (
        <TeamSettings
          sessionId={sessionId}
          initialAgentId={settingsAgentId}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsAgentId(undefined);
          }}
          onSaved={() => void data.load()}
        />
      )}
    </div>
  );
}

/** 消息气泡 */
function MessageBubble({
  message,
  onOpenFile,
  runStatusMap,
}: {
  message: TeamMessage;
  onOpenFile?: (p: string) => void;
  runStatusMap?: Record<string, { status: string; task: string; createdAt: number }>;
}) {
  const { t } = useI18n();
  if (message.kind === "system") {
    return <div style={styles.systemLine}>{message.content}</div>;
  }
  if (message.kind === "handoff") {
    return (
      <div style={{ ...styles.systemLine, color: "var(--accent)" }}>
        🔁 {t("team.handoff")}: {message.content}
      </div>
    );
  }
  if (message.kind === "imported") {
    // 历史导入消息：与普通 agent 消息一致的左侧气泡（emoji + 名字），仅固定 🤖 标识历史来源
    return (
      <div style={{ ...styles.bubbleRow, justifyContent: "flex-start" }}>
        <div style={{ maxWidth: "72%", ...styles.bubble, ...styles.bubbleAgent, opacity: 0.92 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 600, marginBottom: 4 }}>
            🤖 {message.role ?? "原会话"}
          </div>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 13, lineHeight: 1.5 }}>{message.content}</div>
        </div>
      </div>
    );
  }
  const isUser = message.kind === "user";
  // run 发起消息（task-user-*）：显示运行状态小标，等同普通会话里“用户发送了一条任务”
  const runStatus = runStatusMap?.[message.id];
  return (
    <div style={{ ...styles.bubbleRow, justifyContent: isUser ? "flex-end" : "flex-start" }}>
      <div style={{ maxWidth: "72%", ...styles.bubble, ...(isUser ? styles.bubbleUser : styles.bubbleAgent) }}>
        {!isUser && message.agentId && (
          <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, marginBottom: 4 }}>
            {ROLE_EMOJI[message.agentId ?? ""] ?? "🤖"} {message.role ?? message.agentId}
          </div>
        )}
        {isUser && !!runStatus && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 4,
              opacity: 0.85,
            }}
          >
            <span style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}>
              {new Date(runStatus.createdAt).toLocaleTimeString()}
            </span>
            <span style={runStatusChip(runStatus.status as string)}>{runStatus.status}</span>
          </div>
        )}
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 13, lineHeight: 1.5 }}>{message.content}</div>
        {message.artifacts && message.artifacts.length > 0 && (
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
            {message.artifacts.map((a) => (
              <button
                key={a.id}
                onClick={() => onOpenFile?.(a.path)}
                style={styles.artifactLink}
                title={a.description ?? a.path}
              >
                📎 {a.path}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    background: "var(--bg)",
  },
  header: {
    padding: "10px 16px",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    flexWrap: "wrap",
  },
  badge: {
    fontSize: 10,
    background: "var(--accent-soft, rgba(0,120,255,0.12))",
    color: "var(--accent)",
    borderRadius: 8,
    padding: "2px 8px",
    whiteSpace: "nowrap",
  },
  agentChip: {
    fontSize: 11,
    background: "var(--bg-soft, rgba(0,0,0,0.04))",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "2px 8px",
    color: "var(--text)",
    whiteSpace: "nowrap",
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
  },
  modeChip: {
    fontSize: 10,
    color: "var(--text-muted)",
    border: "1px dashed var(--border)",
    borderRadius: 8,
    padding: "2px 6px",
  },
  settingsBtn: {
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 8,
    fontSize: 13,
    padding: "2px 8px",
    cursor: "pointer",
    color: "var(--text-muted)",
  },
  statusBar: {
    padding: "6px 16px",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    gap: 12,
    alignItems: "center",
    flexWrap: "wrap",
    background: "var(--bg-soft, rgba(0,0,0,0.02))",
  },
  messages: {
    flex: 1,
    overflowY: "auto",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: 4,
    color: "var(--text-muted)",
  },
  bubbleRow: { display: "flex", width: "100%" },
  bubble: {
    padding: "8px 12px",
    borderRadius: 12,
    fontSize: 13,
  },
  bubbleUser: {
    background: "var(--accent)",
    color: "#fff",
    borderBottomRightRadius: 4,
  },
  bubbleAgent: {
    background: "var(--bg-soft, rgba(0,0,0,0.05))",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderBottomLeftRadius: 4,
  },
  systemLine: {
    textAlign: "center",
    fontSize: 12,
    color: "var(--text-muted)",
    padding: "4px 8px",
  },
  artifactLink: {
    textAlign: "left" as const,
    fontSize: 12,
    color: "var(--accent)",
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
  },
  error: {
    padding: "8px 16px",
    color: "#dc2626",
    fontSize: 12,
    background: "rgba(220,38,38,0.08)",
  },
  inputArea: {
    borderTop: "1px solid var(--border)",
    padding: "12px 16px",
    background: "var(--bg)",
    position: "relative",
  },
  acMenu: {
    position: "absolute",
    bottom: "100%",
    left: 8,
    right: 8,
    marginBottom: 4,
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    padding: 4,
    display: "flex",
    flexDirection: "column",
    gap: 1,
    maxHeight: 220,
    overflowY: "auto",
    zIndex: 30,
  },
  acItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: "transparent",
    border: "none",
    borderRadius: 7,
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 12.5,
    textAlign: "left",
    width: "100%",
  },
  textarea: {
    width: "100%",
    resize: "none",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 13,
    fontFamily: "inherit",
    background: "var(--bg)",
    color: "var(--text)",
    outline: "none",
  },
  steerInput: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    background: "var(--bg)",
    color: "var(--text)",
    outline: "none",
  },
  composer: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "10px 12px",
    border: "1px solid var(--border)",
    borderRadius: 14,
    background: "var(--bg)",
    boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -16px rgba(15,23,42,0.10)",
  },
  composerRow: {
    display: "flex",
    alignItems: "flex-end",
    gap: 6,
  },
  composerTextarea: {
    flex: 1,
    minWidth: 0,
    width: "100%",
    background: "none",
    border: "none",
    outline: "none",
    resize: "none",
    color: "var(--text)",
    fontSize: 14,
    lineHeight: 1.6,
    fontFamily: "inherit",
    minHeight: 40,
    maxHeight: 200,
    overflow: "auto",
    padding: "2px 0",
  },
  composerSteer: {
    display: "flex",
    gap: 6,
  },
  btnPrimaryInline: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 14px",
    background: "var(--accent)",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    opacity: 1,
    transition: "background 0.15s, box-shadow 0.15s",
  },
  btnDangerInline: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    padding: 0,
    background: "rgba(220,38,38,0.1)",
    border: "1px solid rgba(220,38,38,0.3)",
    borderRadius: 8,
    color: "#dc2626",
    cursor: "pointer",
    fontSize: 14,
  },
  runFooter: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    flexWrap: "wrap",
    marginTop: 6,
    fontSize: 11,
    color: "var(--text-muted)",
    padding: "4px 10px",
    borderTop: "1px dashed var(--border)",
  },
  btnPrimary: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer",
    opacity: 1,
  },
  btnSecondary: {
    background: "var(--bg-soft, rgba(0,0,0,0.05))",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 12,
    cursor: "pointer",
  },
  btnDanger: {
    background: "rgba(220,38,38,0.1)",
    color: "#dc2626",
    border: "1px solid rgba(220,38,38,0.3)",
    borderRadius: 8,
    padding: "6px 14px",
    fontSize: 13,
    cursor: "pointer",
  },
};

function runStatusChip(status: string) {
  const bg =
    status === "completed"
      ? "rgba(16,185,129,0.12)"
      : status === "running" || status === "pending"
        ? "rgba(59,130,246,0.12)"
        : status === "cancelled"
          ? "rgba(107,114,128,0.15)"
          : "rgba(220,38,38,0.1)";
  const color =
    status === "completed"
      ? "#10b981"
      : status === "running" || status === "pending"
        ? "#3b82f6"
        : status === "cancelled"
          ? "#6b7280"
          : "#dc2626";
  return { fontSize: 10, borderRadius: 6, padding: "1px 6px", background: bg, color };
}
