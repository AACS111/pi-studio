/**
 * TeamChat —— 项目组主视图（Phase 1B）。
 * 群聊消息流（user/agent/system/handoff/imported）+ 任务发布 + 运行状态 + 历史。
 */
"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTeamRun } from "@/hooks/useTeamRun";
import { MarkdownBody } from "./MarkdownBody";
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

/** 旧版内置角色中文默认名：若 team.json 里 agent.name 还是这些旧值则回退显示英文 id（保证旧团队也统一英文显示） */
const LEGACY_CN_NAMES = new Set(["组长", "产品", "开发", "测试", "研究员", "文档"]);

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
  // —— 输入框高度（上下拖拽调整）——
  const [composerH, setComposerH] = useState(48);
  const composerDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const startComposerDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    composerDragRef.current = { startY: e.clientY, startH: composerH };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveComposerDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = composerDragRef.current;
    if (!d) return;
    const delta = d.startY - e.clientY; // 向上拖动增大高度
    const h = Math.max(40, Math.min(320, d.startH + delta));
    setComposerH(h);
  };
  const endComposerDrag = () => { composerDragRef.current = null; };
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

  // 产物自动推右侧查看器：新增 artifact 事件时（md/xlsx/docx 等可预览文件）标记打开
  const pushedArtifacts = useRef<Set<string>>(new Set());
  // 切换 run 时重置去重集合（不同 run 的产物独立推送）
  useEffect(() => {
    pushedArtifacts.current = new Set();
  }, [data.activeRunId]);
  useEffect(() => {
    const lastArtifact = [...data.events]
      .reverse()
      .find((e) => e.type === "artifact_produced") as
      | (Extract<typeof data.events[number], { type: "artifact_produced" }>)
      | undefined;
    if (!lastArtifact || !onOpenFile) return;
    const { path, type: artifactType, description } = lastArtifact.artifact;
    // 仅推可预览的文件产物（md/xlsx/docx/univer/png…），且 cwd 下相对路径解析
    if (artifactType !== "file") return;
    const cwd = data.team?.cwd;
    if (!cwd) return;
    if (pushedArtifacts.current.has(path)) return;
    pushedArtifacts.current.add(path);
    const full = path.includes(":") || path.startsWith("/") ? path : `${cwd.replace(/\\/g, "/")}/${path}`;
    void fetch("/api/open-file-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: full, title: description ?? path }),
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.events.length]);

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

  // —— 群聊数据装配 ——
  // 角色显示信息（emoji + 名字 + 颜色点）：按 agentId 从团队配置解析
  // 内置角色若 name 还是旧中文默认名则回退显示英文 id（LEGACY_CN_NAMES 模块常量）
  const roleInfoById = useMemo(() => {
    const map: Record<string, { emoji: string; name: string; dot: string }> = {};
    const agents = data.team?.agents ?? [];
    const palette = [
      "#3b82f6", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444",
      "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1",
      "#14b8a6", "#e11d48", "#a855f7", "#22c55e", "#0ea5e9",
    ];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const displayName = LEGACY_CN_NAMES.has(a.name) ? a.id : a.name;
      map[a.id] = { emoji: a.emoji ?? ROLE_EMOJI[a.id] ?? "🤖", name: displayName, dot: palette[i % palette.length] };
    }
    return map;
  }, [data.team?.agents]);

  // 思考过程按执行（execution）归组：从完整事件流抽取 agent_progress（运行中实时追加，历史 run 的最近一次也在内存里）
  const thinkingByExecution = useMemo(() => {
    const groups: Record<string, Array<{ kind: "thinking" | "tool"; content: string; timestamp: number }>> = {};
    for (const ev of data.events) {
      if (ev.type !== "agent_progress") continue;
      const g = groups[ev.executionId] ?? (groups[ev.executionId] = []);
      g.push({ kind: ev.kind, content: ev.content, timestamp: ev.timestamp });
    }
    for (const key of Object.keys(groups)) groups[key].sort((a, b) => a.timestamp - b.timestamp);
    return groups;
  }, [data.events]);

  // 执行 → 思考文本（thinking 片段拼接 + tool 行引用样式）
  const thinkingTextOf = (executionId?: string): string => {
    if (!executionId) return "";
    const items = thinkingByExecution[executionId];
    if (!items) return "";
    const segs: string[] = [];
    for (const it of items) {
      if (it.kind === "thinking") segs.push(it.content);
      else segs.push(`\n> 🔧 ${it.content}`);
    }
    return segs.join("\n");
  };
  const toolCountOf = (executionId?: string): number =>
    executionId ? thinkingByExecution[executionId]?.filter((i) => i.kind === "tool").length ?? 0 : 0;

  // 执行元数据表：executionId → 状态/统计（供最终消息徽标）
  const execStatusById = useMemo(() => {
    const map: Record<string, { status: string; toolCalls?: number; totalTokens?: number; cost?: number }> = {};
    for (const e of data.projections?.executions ?? []) {
      map[e.id] = { status: e.status, toolCalls: e.stats?.toolCalls, totalTokens: e.stats?.totalTokens, cost: e.stats?.cost };
    }
    return map;
  }, [data.projections?.executions]);

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
        label: LEGACY_CN_NAMES.has(a.name) ? a.id : a.name,
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

  // 实时进度：按执行（execution）聚合的完整 thinking 流水（不做条数截断，直接随消息区向上生长）
  const liveProgressByExec = useMemo<Array<{
    executionId: string;
    agentId: string;
    seq: number;
    emoji: string;
    name: string;
    toolCount: number;
    items: Array<{ kind: "thinking" | "tool"; content: string; timestamp: number }>;
  }>>(() => {
    if (!running) return [];
    const execs = data.projections?.executions ?? [];
    const runningIds = new Set(execs.filter((e) => e.status === "running").map((e) => e.id));
    const teamAgents = data.team?.agents ?? [];
    // 每个 running 执行 → 它的完整进度流（thinking 片段按时间拼接 + 工具调用行）
    return execs
      .filter((e) => runningIds.has(e.id))
      .map((e) => {
        const agent = teamAgents.find((a) => a.id === e.agentId);
        const items = data.progress
          .filter((p) => p.executionId === e.id)
          .sort((a, b) => a.timestamp - b.timestamp);
        return {
          executionId: e.id,
          agentId: e.agentId,
          seq: e.sequence,
          emoji: agent?.emoji ?? ROLE_EMOJI[e.agentId] ?? "🤖",
          name: agent ? (LEGACY_CN_NAMES.has(agent.name) ? agent.id : agent.name) : e.agentId,
          toolCount: items.filter((i) => i.kind === "tool").length,
          items,
        };
      });
  }, [data.progress, data.projections?.executions, running, data.team?.agents]);

  // 本轮参与 vs 未参与角色（编排可见性）
  const participation = useMemo(() => {
    const execs = data.projections?.executions ?? [];
    const agents = data.team?.agents ?? [];
    const involved = new Set(execs.map((e) => e.agentId));
    return {
      involved: agents.filter((a) => involved.has(a.id)),
      skipped: agents.filter((a) => !involved.has(a.id)),
    };
  }, [data.projections?.executions, data.team?.agents]);

  return (
    <div style={styles.root}>
      {/* Header（合并为 1 行；空白区作为无边框窗口拖动区） */}
      <div style={styles.header}>
        <div className="app-region-no-drag" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
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
        <div className="app-region-drag" aria-hidden="true" style={{ flex: 1, minWidth: 0, alignSelf: "stretch" }} />
        {data.team && (
          <div className="app-region-no-drag" style={{ display: "flex", gap: 6, flexWrap: "nowrap", alignItems: "center", overflowX: "auto", scrollbarWidth: "thin" }}>
            {(() => {
              const team = data.team;
              return team.agents.map((a) => (
                <span key={a.id} style={{ ...styles.agentChip, cursor: "pointer" }} title={`${t("team.settings.editAgent")}: ${LEGACY_CN_NAMES.has(a.name) ? a.id : a.name}`}>
                  <span
                    onClick={() => {
                      setSettingsAgentId(a.id);
                      setSettingsOpen(true);
                    }}
                  >
                    {a.emoji ?? ROLE_EMOJI[a.id] ?? "🤖"} {LEGACY_CN_NAMES.has(a.name) ? a.id : a.name}
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
            cwd={data.team?.cwd}
            onOpenFile={onOpenFile}
            runStatusMap={runStatusMap}
            roleInfo={roleInfoById[m.agentId ?? ""]}
            thinking={thinkingTextOf(m.executionId)}
            toolCount={toolCountOf(m.executionId)}
            execStatus={execStatusById[m.executionId ?? ""]}
            onAvatarClick={(agentId) => { setSettingsAgentId(agentId); setSettingsOpen(true); }}
          />
        ))}
        {running && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {/* 本轮参与 vs 未参与角色（编排可见性） */}
            {participation.skipped.length > 0 && (
              <div style={styles.skipHint}>
                {t("team.skipHint")}：
                {participation.skipped.map((a) => (
                  <span key={a.id} style={{ marginLeft: 6, opacity: 0.75 }}>
                    {a.emoji ?? ROLE_EMOJI[a.id] ?? "🤖"} {LEGACY_CN_NAMES.has(a.name) ? a.id : a.name}
                  </span>
                ))}
              </div>
            )}
            {/* 实时正文输出：群聊化身 + 可折叠思考区，像普通对话一样平铺在消息流里，无固定高度、不截断 */}
            {liveProgressByExec.map((b) => (
              <LiveRoleBlock
                key={b.executionId}
                emoji={b.emoji}
                name={b.name}
                seq={b.seq}
                dot={roleInfoById[b.agentId]?.dot ?? "#888"}
                items={b.items}
                toolCount={b.toolCount}
              />
            ))}
            {running && liveProgressByExec.length === 0 && (
              <div style={styles.systemLine}>
                <span style={{ color: "var(--text-muted)" }}>⏳ {t("team.agentsWorking")}…</span>
              </div>
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
              style={{ ...styles.composerTextarea, height: composerH }}
            />
            {running ? (
              <button
                onClick={() => void data.cancelRun()}
                style={styles.btnDangerInline}
                title={t("team.stopRun")}
                aria-label={t("team.stopRun")}
              >
                ⏹ {t("team.stopRun")}
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
          {/* 上下拖动：调整输入框高度 */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("team.resizeHint")}
            title={t("team.resizeHint")}
            onPointerDown={startComposerDrag}
            onPointerMove={moveComposerDrag}
            onPointerUp={endComposerDrag}
            onPointerCancel={endComposerDrag}
            style={styles.composerResizer}
          >
            <span style={{ width: 44, height: 3, borderRadius: 2, background: "var(--border)", flexShrink: 0 }} />
          </div>
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
                  ⚡ {runStatus.stats.tokensUsed.toLocaleString("zh-CN")} tok · hops {runStatus.stats.hopCount} / rework {runStatus.stats.reworkCount} / execs {runStatus.stats.agentExecutions}
                </span>
              </>
            )}
            {data.connected && <span style={{ fontSize: 11, color: "var(--accent)" }}>● {t("team.live")}</span>}
          </div>
        )}
        {/* P1-2：人工审批闸门（等待批准/驳回） */}
        {runStatus?.status === "waiting_approval" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, padding: "10px 12px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", flex: 1 }}>
              🔒 等待人工审批：{runStatus.pendingApproval?.from ?? "?"} → {runStatus.pendingApproval?.to ?? "?"}
            </span>
            <button onClick={() => data.approveRun()} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid rgba(46,194,125,0.4)", background: "rgba(46,194,125,0.12)", color: "#2ec27e", fontSize: 12, cursor: "pointer" }}>
              ✅ 批准
            </button>
            <button onClick={() => data.rejectRun()} style={{ padding: "5px 12px", borderRadius: 7, border: "1px solid rgba(229,72,77,0.4)", background: "rgba(229,72,77,0.12)", color: "#e5484d", fontSize: 12, cursor: "pointer" }}>
              ⛔ 驳回
            </button>
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

/** 群聊头像：圆形 emoji 头像 + 角色专属颜色描边/底色。 */
function RoleAvatar({ emoji, dot, size = 34, clickable, onClick, title }: { emoji: string; dot: string; size?: number; clickable?: boolean; onClick?: () => void; title?: string }) {
  const avatar = (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.5),
        background: "var(--bg-panel, rgba(0,0,0,0.03))",
        border: `2px solid ${dot}`,
        boxShadow: "0 1px 3px rgba(15,23,42,0.12)",
        userSelect: "none",
        ...(clickable ? { cursor: "pointer", transition: "transform 0.12s, box-shadow 0.12s" } : {}),
      }}
    >
      {emoji}
    </div>
  );
  if (clickable && onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        style={{ border: "none", background: "none", padding: 0, lineHeight: 0 }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.08)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
      >
        {avatar}
      </button>
    );
  }
  return avatar;
}

/** 可折叠思考区：灰底面板，折叠态显示摘要行，展开态完整展示 thinking 流水（Markdown 化 + 工具行）。 */
function ThinkingCollapsible({
  thinking,
  toolCount,
  live = false,
}: {
  thinking: string;
  toolCount: number;
  live?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // prefers-reduced-motion 用户：跳过过渡动画
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const hasThinking = thinking.trim().length > 0;
  const label = live
    ? toolCount > 0
      ? `${t("team.thinkingLive")} · 🔧 ${toolCount} ${t("team.toolCalls")}`
      : `${t("team.thinkingLive")}`
    : toolCount > 0
      ? `${t("team.thinkingCollapsed")} · 🔧 ${toolCount} ${t("team.toolCalls")}`
      : t("team.thinkingCollapsed");

  if (!hasThinking && !live) return null;
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? t("i18n.collapse") : t("i18n.expand")}
        style={{ ...styles.thinkToggle, ...(!open ? styles.thinkToggleCollapsed : {}) }}
      >
        <span style={{ fontSize: 12 }}>🧠</span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span style={{ fontSize: 10, opacity: 0.7, flexShrink: 0 }}>
          {open ? "▴ " + t("i18n.collapse") : "▾ " + t("i18n.expand")}
        </span>
      </button>
      {open && (
        <div
          style={{
            ...styles.thinkBody,
            transition: reduced ? "none" : "max-height 0.25s ease",
          }}
        >
          {hasThinking ? (
            <MarkdownBody className="markdown-team-thinking" >{thinking}</MarkdownBody>
          ) : (
            <span style={{ color: "var(--text-dim)" }}>⏳ {t("team.stepInProgress")}…</span>
          )}
        </div>
      )}
    </div>
  );
}

/** 群聊消息块：用户消息右侧 accent 气泡；角色消息左侧“头像 + 名字 + 时间 + 可折叠思考区 + 最终输出”。 */
function MessageBubble({
  message,
  cwd,
  onOpenFile,
  runStatusMap,
  roleInfo,
  thinking,
  toolCount,
  execStatus,
  onAvatarClick,
}: {
  message: TeamMessage;
  cwd?: string;
  onOpenFile?: (p: string) => void;
  runStatusMap?: Record<string, { status: string; task: string; createdAt: number }>;
  roleInfo?: { emoji: string; name: string; dot: string };
  thinking?: string;
  toolCount?: number;
  execStatus?: { status: string; toolCalls?: number; totalTokens?: number; cost?: number };
  onAvatarClick?: (agentId: string) => void;
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
  const isUser = message.kind === "user";
  // run 发起消息（task-user-*）：显示运行状态小标，等同普通会话里“用户发送了一条任务”
  const runStatus = runStatusMap?.[message.id];

  // 角色最终消息群聊块
  if (!isUser) {
    const emoji = roleInfo?.emoji ?? ROLE_EMOJI[message.agentId ?? ""] ?? "🤖";
    const name = roleInfo?.name ?? message.role ?? message.agentId ?? (message.kind === "imported" ? "原会话" : "Agent");
    const dot = roleInfo?.dot ?? "#888";
    return (
      <div style={styles.groupRow}>
        <RoleAvatar emoji={emoji} dot={dot} clickable={!!onAvatarClick && !!message.agentId} onClick={onAvatarClick && message.agentId ? () => onAvatarClick(message.agentId!) : undefined} title={onAvatarClick ? t("team.settings.editAgent") : undefined} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={styles.groupMeta}>
            <span style={{ fontWeight: 600, fontSize: 12.5 }}>{name}</span>
            {execStatus && execStatus.status && (
              <span style={runStatusChip(execStatus.status)}>{execStatus.status}</span>
            )}
            {toolCount && toolCount > 0 && (
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>🔧 {toolCount}</span>
            )}
            <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {new Date(message.createdAt).toLocaleTimeString()}
            </span>
          </div>
          {message.kind !== "imported" && (
            <ThinkingCollapsible thinking={thinking ?? ""} toolCount={toolCount ?? 0} />
          )}
          <div style={styles.bubbleOuter}>
            <div style={{ fontSize: 13, lineHeight: 1.55 }}>
              <MarkdownBody className={`markdown-team-message${isUser ? " markdown-team-user" : ""}`} cwd={cwd}>{message.content}</MarkdownBody>
            </div>
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
      </div>
    );
  }

  // 用户（右侧 accent 气泡）
  return (
    <div style={{ ...styles.bubbleRow, justifyContent: "flex-end" }}>
      <div style={{ ...styles.bubble, ...styles.bubbleUser, maxWidth: "72%" }}>
        {!!runStatus && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, opacity: 0.85 }}>
            <span style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}>
              {new Date(runStatus.createdAt).toLocaleTimeString()}
            </span>
            <span style={runStatusChip(runStatus.status as string)}>{runStatus.status}</span>
          </div>
        )}
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <MarkdownBody className="markdown-team-message markdown-team-user" cwd={cwd}>{message.content}</MarkdownBody>
        </div>
      </div>
    </div>
  );
}

/** 实时角色块（running 中）：群聊头像 + 名字 + 可折叠思考区（实时追加），正文由“… 正在执行”占位。 */
function LiveRoleBlock({
  emoji,
  name,
  seq,
  dot,
  items,
  toolCount,
}: {
  emoji: string;
  name: string;
  seq: number;
  dot: string;
  items: Array<{ kind: "thinking" | "tool"; content: string; timestamp: number }>;
  toolCount: number;
}) {
  const { t } = useI18n();
  const segs: string[] = [];
  for (const it of items) {
    if (it.kind === "thinking") segs.push(it.content);
    else segs.push(`\n> 🔧 ${it.content}`);
  }
  const thinking = segs.join("\n");
  return (
    <div style={styles.groupRow}>
      <RoleAvatar emoji={emoji} dot={dot} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={styles.groupMeta}>
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>{name}</span>
          {seq > 1 && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>#{seq}</span>}
          <span style={{ ...runStatusChip("running"), marginLeft: "auto" }}>
            <span className="team-live-dot">●</span> {t("team.stepInProgress")}
          </span>
        </div>
        <ThinkingCollapsible thinking={thinking} toolCount={toolCount} live />
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>… {t("team.stepInProgress")}</div>
        {toolCount > 0 && (
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>🔧 {toolCount} {t("team.toolCalls")}</div>
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
    padding: "8px 12px",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    flexWrap: "nowrap",
    minWidth: 0,
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
  skipHint: {
    fontSize: 11,
    color: "var(--text-muted)",
    padding: "2px 6px",
    borderTop: "1px dashed var(--border)",
    marginTop: 4,
    paddingTop: 6,
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
  // —— 群聊布局 ——
  groupRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    width: "100%",
  },
  groupMeta: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    minHeight: 22,
  },
  bubbleOuter: {
    padding: "10px 12px",
    borderRadius: 12,
    background: "var(--bg-soft, rgba(0,0,0,0.04))",
    border: "1px solid var(--hairline, var(--border))",
    borderTopLeftRadius: 4,
  },
  thinkToggle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: "5px 10px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-soft, rgba(0,0,0,0.03))",
    color: "var(--text-muted)",
    fontSize: 11.5,
    cursor: "pointer",
    textAlign: "left",
  },
  thinkToggleCollapsed: {
    background: "var(--bg, rgba(0,0,0,0.02))",
    opacity: 0.9,
  },
  thinkBody: {
    marginTop: 4,
    padding: "9px 12px",
    borderRadius: 8,
    background: "var(--bg-panel, rgba(0,0,0,0.02))",
    border: "1px solid transparent",
    borderLeft: "3px solid var(--border)",
    maxHeight: 380,
    overflowY: "auto",
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
    overflow: "auto",
    padding: "2px 0",
  },
  composerResizer: {
    alignSelf: "center",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: 14,
    marginTop: 2,
    cursor: "ns-resize",
    touchAction: "none",
    borderRadius: 6,
    opacity: 0.7,
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
    gap: 6,
    padding: "7px 14px",
    background: "rgba(220,38,38,0.1)",
    border: "1px solid rgba(220,38,38,0.3)",
    borderRadius: 8,
    color: "#dc2626",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: "nowrap",
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


