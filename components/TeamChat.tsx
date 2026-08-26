/**
 * TeamChat —— 项目组主视图（Phase 1B）。
 * 群聊消息流（user/agent/system/handoff/imported）+ 任务发布 + 运行状态 + 历史。
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTeamRun } from "@/hooks/useTeamRun";
import { MarkdownBody } from "./MarkdownBody";
import { resolveFilePath } from "@/lib/file-paths";
import { ChangedFilesCard } from "./ChangedFilesCard";
import { TeamSettings } from "./TeamSettings";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import type { ExecutionMode, TeamMessage } from "@/lib/team/types";

interface Props {
  sessionId: string;
  teamName?: string;
  onOpenFile?: (path: string) => void;
  /** 复用普通会话的输入框句柄：让文件浏览器的「插入路径」能写入项目组的任务输入框 */
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
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

/** 执行模式选项（输入框旁选择器顺序） */
const EXEC_MODES: ExecutionMode[] = ["auto", "solo", "serial", "parallel", "custom"];

/** 从思考/工具文本中提取“引用文件”（含路径分隔符且带常见代码/文档扩展名），去重、限量。
 *  用于 running 角色的思考区下方生成可点击的文件 chips，用户点击即可在右侧查看器打开。
 *  启发式：匹配含 / 或 \\ 分隔符的路径 + 扩展名（如 src/views/Mps.vue、C:/a/b/Report.ts），
 *  过滤掉方法名/数字/URL 等无分隔符噪音。 */
const REF_FILE_EXT = "vue|ts|tsx|js|jsx|java|md|json|xml|yml|yaml|sql|css|scss|less|py|rb|go|sh|html|txt|ini|env|kt|cs|cpp|c|h|gradle";
function extractReferencedFiles(texts: string[], max = 12): string[] {
  const combined = texts.filter(Boolean).join("\n");
  const re = new RegExp(
    `(?:[A-Za-z]:[\\\\/]|[\\\\/]|\\.\\.?[\\\\/])?((?:[A-Za-z0-9_@.-]+[\\\\/])+[A-Za-z0-9_@.-]+\\\\.(?:${REF_FILE_EXT})\\b)`,
    "g",
  );
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(combined)) && out.length < max) {
    const p = m[1].replace(/^\\.\[/, "");
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** 旧版内置角色中文默认名：若 team.json 里 agent.name 还是这些旧值则回退显示英文 id（保证旧团队也统一英文显示） */
const LEGACY_CN_NAMES = new Set(["组长", "产品", "开发", "测试", "研究员", "文档"]);

/** 展示用模型名：直接显示具体模型 id（跟随系统时后端已解析出实际模型名）；太长则截断 */
function modelDisplayName(modelId: string): string {
  if (!modelId) return "跟随系统";
  return modelId.length > 26 ? modelId.slice(0, 23) + "…" : modelId;
}


export function TeamChat({ sessionId, teamName, onOpenFile, chatInputRef }: Props) {
  const { t } = useI18n();
  const data = useTeamRun(sessionId);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  // 执行模式与「项目组设置 → 团队参数 → 执行模式」共用同一个存储变量（TeamDef.executionMode）：
  // 外部下拉与设置弹窗改的是同一个值，双向同步。
  const executionMode = data.team?.executionMode ?? "auto";
  const [execHelp, setExecHelp] = useState(false);
  const [execMenuOpen, setExecMenuOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsAgentId, setSettingsAgentId] = useState<string | undefined>(undefined);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
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
    const groups: Record<string, Array<{ kind: "thinking" | "tool" | "model"; content: string; timestamp: number }>> = {};
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
    const map: Record<string, { status: string; toolCalls?: number; totalTokens?: number; cost?: number; model?: { provider: string; modelId: string }; changedFiles?: { filePath: string; kind: "edit" | "write" }[]; sessionPath?: string; thinkingPath?: string }> = {};
    for (const e of data.projections?.executions ?? []) {
      map[e.id] = { status: e.status, toolCalls: e.stats?.toolCalls, totalTokens: e.stats?.totalTokens, cost: e.stats?.cost, model: e.model, changedFiles: e.changedFiles, sessionPath: e.sessionPath, thinkingPath: e.thinkingPath };
    }
    return map;
  }, [data.projections?.executions]);

  const handlePost = useCallback(async (text: string) => {
    const msg = (text ?? "").trim();
    if (!msg || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      // 起始角色固定 = 项目组设置的入口角色（entryAgentId），不再在对话窗口重复选择
      await data.startRun(msg, undefined, executionMode);
    } catch (e) {
      setPostError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }, [posting, data, executionMode]);

  const handleSteer = useCallback(async (msg: string) => {
    const text = (msg ?? "").trim();
    if (!text) return;
    try {
      await data.steer(text);
      setPostError(null);
    } catch {
      setPostError("steer failed");
    }
  }, [data]);

  /** 变更执行模式：写同一个 TeamDef.executionMode 存储变量（与项目组设置共享），并刷新 */
  const changeExecutionMode = useCallback(async (mode: ExecutionMode) => {
    setExecHelp(false);
    setExecMenuOpen(false);
    try {
      await fetch(`/api/teams/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ executionMode: mode }),
      });
      await data.load();
    } catch {
      /* 失败静默；下次打开设置可再改 */
    }
  }, [sessionId, data]);

  /** 上传文件：放入上传管理器，并把文件路径插入任务输入框，方便项目组引用 */
  const handleUploadFiles = useCallback(async (files: File[]) => {
    if (!files.length || uploadBusy) return;
    setUploadBusy(true);
    const formData = new FormData();
    for (const f of files) formData.append("files", f, f.name);
    try {
      const res = await fetch("/api/uploads", { method: "POST", body: formData });
      const data = (await res.json().catch(() => ({}))) as { uploaded?: Array<{ path: string }> };
      const paths = (data.uploaded ?? []).map((u) => u.path).filter(Boolean);
      if (paths.length && chatInputRef?.current) {
        chatInputRef.current.insertText(paths.join(" "));
      }
    } catch {
      /* 上传失败静默；用户可从上传管理器重试 */
    } finally {
      setUploadBusy(false);
    }
  }, [uploadBusy, chatInputRef]);

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
    model?: string;
    items: Array<{ kind: "thinking" | "tool" | "model"; content: string; timestamp: number }>;
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
        // 运行中实际生效模型：executor 会话就绪后实时推送（含「跟随系统」解析出的具体模型名）
        const modelItems = items.filter((i) => i.kind === "model");
        const model = modelItems.length ? modelItems[modelItems.length - 1].content : undefined;
        return {
          executionId: e.id,
          agentId: e.agentId,
          seq: e.sequence,
          emoji: agent?.emoji ?? ROLE_EMOJI[e.agentId] ?? "🤖",
          name: agent ? (LEGACY_CN_NAMES.has(agent.name) ? agent.id : agent.name) : e.agentId,
          toolCount: items.filter((i) => i.kind === "tool").length,
          model,
          items,
        };
      });
  }, [data.progress, data.projections?.executions, running, data.team?.agents]);

  // 是否已画自定义工作流（transitions 或 gateways 非空 → 允许选「自定义」模式）
  const hasWorkflow = useMemo(
    () => (data.team?.transitions?.length ?? 0) > 0 || (data.team?.gateways?.length ?? 0) > 0,
    [data.team?.transitions, data.team?.gateways],
  );

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
            {/* 本轮参与角色总览：清晰展示「参与中/已完成/未参与」，避免只见正在跑的角色而误以为其他人消失 */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", fontSize: 11, color: "var(--text-muted)" }}>
              <span style={{ opacity: 0.85 }}>{t("team.participated")}：</span>
              {participation.involved.map((a) => {
                const runningNow = liveProgressByExec.some((b) => b.agentId === a.id);
                return (
                  <span
                    key={a.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      padding: "1px 8px",
                      borderRadius: 10,
                      border: `1px solid ${runningNow ? "var(--accent)" : "var(--border)"}`,
                      background: runningNow
                        ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                        : "var(--bg-soft, rgba(0,0,0,0.03))",
                      color: runningNow ? "var(--accent)" : "var(--text-muted)",
                    }}
                  >
                    {a.emoji ?? ROLE_EMOJI[a.id] ?? "🤖"} {LEGACY_CN_NAMES.has(a.name) ? a.id : a.name}
                    <span style={{ fontSize: 10 }}>{runningNow ? "●" : "✓"}</span>
                  </span>
                );
              })}
            </div>
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
                model={b.model}
                cwd={data.team?.cwd}
                onOpenFile={onOpenFile}
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

      {/* 输入区（复用普通会话 ChatInput：@ 文件 / / 技能 自动补全、发送、流式介入/停止，与普通会话完全一致） */}
      <div style={styles.inputArea}>
        <ChatInput
          ref={chatInputRef}
          onSend={(msg) => void handlePost(msg)}
          onAbort={() => void data.cancelRun()}
          onSteer={(msg) => void handleSteer(msg)}
          isStreaming={running}
          cwd={data.team?.cwd ?? undefined}
          draftKey={`team-${sessionId}`}
          placeholder={t("team.inputPlaceholder")}
          hideAttach
        />
        {/* 输入框下方工具条：上传文件 + 执行模式下拉（与普通会话底部工具条一致；对齐输入框居中；run 级生效，运行中锁定） */}
        <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <div style={styles.inputToolbar}>
          {/* 上传文件 */}
          <button
            type="button"
            disabled={uploadBusy || running}
            onClick={() => fileInputRef.current?.click()}
            title={uploadBusy ? t("chat.uploadFileBusy") : t("chat.uploadFile")}
            aria-label={t("chat.uploadFile")}
            style={styles.inputToolbarBtn}
          >
            {uploadBusy ? (
              <span style={{ width: 13, height: 13, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite", display: "inline-block" }} />
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            disabled={uploadBusy || running}
            style={{ display: "none" }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) void handleUploadFiles(files);
              e.target.value = "";
            }}
          />
          {/* 执行模式下拉（系统判断/单独/串行/并行/自定义） */}
          <div style={styles.execModeRow}>
            <button
              type="button"
              disabled={running}
              onClick={() => setExecMenuOpen((o) => !o)}
              title={t("team.execMode.title")}
              aria-haspopup="listbox"
              aria-expanded={execMenuOpen}
              style={{
                ...styles.execModeSelect,
                ...(execMenuOpen ? styles.execModeSelectOpen : {}),
                ...(running ? styles.execModePillDisabled : {}),
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.8 }} aria-hidden="true">
                <polyline points="9 5 4 9 9 13" />
                <polyline points="15 5 20 9 15 13" />
              </svg>
              <span style={{ flex: 1, textAlign: "left", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t(`team.execMode.${executionMode}`)}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }} aria-hidden="true">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {execMenuOpen && (
              <>
                <div style={styles.execModeBackdrop} onClick={() => setExecMenuOpen(false)} aria-hidden="true" />
                <div style={styles.execModeMenu} role="listbox" aria-label={t("team.execMode.title")}>
                  {(EXEC_MODES as ExecutionMode[]).map((m) => {
                    const blocked = m === "custom" && !hasWorkflow;
                    const active = executionMode === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => {
                          if (blocked) {
                            setExecHelp(true);
                            return;
                          }
                          void changeExecutionMode(m);
                        }}
                        title={blocked ? t("team.execMode.customNeedWorkflow") : t(`team.execMode.desc.${m}`)}
                        style={{
                          ...styles.execModeMenuItem,
                          ...(active ? styles.execModeMenuItemActive : {}),
                          ...(blocked ? styles.execModeMenuItemBlocked : {}),
                        }}
                      >
                        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                          <span style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t(`team.execMode.${m}`)}</span>
                          <span style={{ fontSize: 10.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t(`team.execMode.desc.${m}`)}</span>
                        </span>
                        {active && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
        </div>
        {execHelp && (
          <div style={styles.execModeHint}>
            {t("team.execMode.customHelp")}
          </div>
        )}

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

/** 可折叠思考区：灰底面板，折叠态显示摘要行，展开态完整展示 thinking 流水（Markdown 化 + 工具行）。
 *  live=true（执行中实时追加）时默认展开——用户要像普通会话一样实时看到思考过程；
 *  非 live（已完成的消息气泡）默认折叠。 */
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
  const [open, setOpen] = useState(live);
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

  // 执行中流式思考自动滚到底部：保持最新思考可见（用户滚到上方回看时不打断）
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || !live) return;
    const el = bodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      // rAF 节流：避免每段 thinking 到达都同步碰 DOM 引发滚动抖动/重排
      const raf = requestAnimationFrame(() => {
        const node = bodyRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [thinking, open, live]);

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
          ref={bodyRef}
          style={{
            ...styles.thinkBody,
            transition: reduced ? "none" : "max-height 0.25s ease",
          }}
        >
          {hasThinking ? (
            <div
              className="markdown-team-thinking"
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--text)",
              }}
            >
              {thinking}
            </div>
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
  execStatus?: { status: string; toolCalls?: number; totalTokens?: number; cost?: number; model?: { provider: string; modelId: string }; changedFiles?: { filePath: string; kind: "edit" | "write" }[]; sessionPath?: string; thinkingPath?: string };
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
            {execStatus?.model?.modelId && (
              <span
                title={`${execStatus.model.provider}/${execStatus.model.modelId}`}
                style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", background: "color-mix(in srgb, var(--text-muted) 12%, transparent)", padding: "1px 6px", borderRadius: 6 }}
              >
                {modelDisplayName(execStatus.model.modelId)}
              </span>
            )}
            {toolCount && toolCount > 0 && (
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>🔧 {toolCount}</span>
            )}
            <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {new Date(message.createdAt).toLocaleTimeString()}
            </span>
          </div>
          {message.kind !== "imported" && (execStatus?.thinkingPath || execStatus?.sessionPath) ? (
            // 历史执行完的角色思考：不再把长篇思考平铺在会话里（否则越滚越长、拖慢渲染），
            // 只保留「查看思考文件」入口——优先打开可读的 thinking .md（右开即正常 markdown 渲染）。
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 2,
                fontSize: 11,
                color: "var(--text-muted)",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              <button
                type="button"
                onClick={() => onOpenFile?.((execStatus.thinkingPath ?? execStatus.sessionPath)!)}
                disabled={!onOpenFile}
                title={execStatus.thinkingPath ?? execStatus.sessionPath}
                style={styles.artifactLink}
              >
                {t("team.viewThinkingFile")}
              </button>
              <span style={{ opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
                {(execStatus.thinkingPath ?? execStatus.sessionPath)!.split(/[\\/]/).pop()}
              </span>
            </div>
          ) : (
            message.kind !== "imported" && (
              <ThinkingCollapsible thinking={thinking ?? ""} toolCount={toolCount ?? 0} />
            )
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
            {execStatus?.changedFiles && execStatus.changedFiles.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <ChangedFilesCard files={execStatus.changedFiles} cwd={cwd} onOpenFile={onOpenFile} />
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
  model,
  cwd,
  onOpenFile,
}: {
  emoji: string;
  name: string;
  seq: number;
  dot: string;
  items: Array<{ kind: "thinking" | "tool" | "model"; content: string; timestamp: number }>;
  toolCount: number;
  model?: string;
  cwd?: string;
  onOpenFile?: (p: string) => void;
}) {
  const { t } = useI18n();
  // 窗口化：思考片段随执行增长可能上千段，若全量 join 成一个大字符串再用 MarkdownBody 渲染，
  // 每来一段新 thinking 都触发整段 reparse → 滚动卡顿。这里只保留最近 MAX_THINKING_SEGS 段，
  // 旧段折叠为「已省略」，把 DOM 大小控制在有限范围（流畅优先，仍能实时看到最新思考）。
  const MAX_THINKING_SEGS = 60;
  const segs: string[] = [];
  for (const it of items) {
    if (it.kind === "thinking") segs.push(it.content);
    else if (it.kind === "tool") segs.push(`\n> 🔧 ${it.content}`);
    // kind === "model"：已在 groupMeta 单独展示模型 chip，不混入思考流水
  }
  const sliced = segs.length > MAX_THINKING_SEGS ? segs.slice(-MAX_THINKING_SEGS) : segs;
  const skippedCount = segs.length - sliced.length;
  const thinking = (skippedCount > 0 ? `…（已省略前面 ${skippedCount} 段思考）\n` : "") + sliced.join("\n");
  // 引用文件：从 thinking + 工具调用文本提取，生成可点击 chips（右侧查看器打开），
  //  否则思考里纯文本文件路径看不清，用户也无法直接点开核实。
  const referencedFiles = useMemo(() => {
    const texts: string[] = [];
    for (const it of items) {
      if (it.kind === "thinking") texts.push(it.content);
      else if (it.kind === "tool") texts.push(it.content);
    }
    return extractReferencedFiles(texts);
  }, [items]);
  return (
    <div style={styles.groupRow}>
      <RoleAvatar emoji={emoji} dot={dot} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={styles.groupMeta}>
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>{name}</span>
          {seq > 1 && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>#{seq}</span>}
          {model && (
            <span
              title={model}
              style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", background: "color-mix(in srgb, var(--text-muted) 12%, transparent)", padding: "1px 6px", borderRadius: 6 }}
            >
              {modelDisplayName(model.split("/").pop() ?? model)}
            </span>
          )}
          <span style={{ ...runStatusChip("running"), marginLeft: "auto" }}>
            <span className="team-live-dot">●</span> {t("team.stepInProgress")}
          </span>
        </div>
        <ThinkingCollapsible thinking={thinking} toolCount={toolCount} live />
        {referencedFiles.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}>
            {referencedFiles.map((f) => (
              <button
                key={f}
                type="button"
                disabled={!onOpenFile}
                onClick={() => onOpenFile?.(resolveFilePath(f, cwd))}
                title={f}
                style={styles.referencedFileChip}
              >
                {f.split(/[\\/]/).pop()}
              </button>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>… {t("team.stepInProgress")}</div>
        {toolCount > 0 && (
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>🔧 {toolCount} {t("team.toolCalls")}</div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  referencedFileChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    maxWidth: 200,
    padding: "1px 8px",
    borderRadius: 9,
    border: "1px solid var(--border)",
    background: "var(--bg-soft, rgba(0,0,0,0.03))",
    color: "var(--text-muted)",
    fontSize: 10.5,
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
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
    // 性能：离屏思考区跳过渲染（虚拟化），大幅缓解长思考滚动卡顿
    contentVisibility: "auto",
    containIntrinsicSize: "auto 300px",
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
  inputToolbar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
  },
  inputToolbarBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 34,
    padding: 0,
    border: "1px solid var(--border)",
    borderRadius: 9,
    background: "var(--bg-soft, rgba(0,0,0,0.03))",
    color: "var(--text-muted)",
    cursor: "pointer",
    transition: "background 0.12s, color 0.12s, border-color 0.12s",
  },
  execModeRow: {
    position: "relative",
    display: "flex",
    alignItems: "center",
  },
  execModeSelect: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 132,
    padding: "6px 10px",
    border: "1px solid var(--border)",
    borderRadius: 9,
    background: "var(--bg-soft, rgba(0,0,0,0.03))",
    color: "var(--text-muted)",
    fontSize: 12,
    cursor: "pointer",
    transition: "background 0.12s, color 0.12s, border-color 0.12s",
  },
  execModeSelectOpen: {
    background: "var(--bg-hover, rgba(0,0,0,0.06))",
    color: "var(--text)",
    borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))",
  },
  execModePillDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  execModeBackdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 90,
    background: "transparent",
  },
  execModeMenu: {
    position: "absolute",
    bottom: "calc(100% + 6px)",
    right: 0,
    zIndex: 100,
    minWidth: 240,
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    boxShadow: "0 -6px 20px rgba(0,0,0,0.14)",
    overflow: "hidden",
    padding: 4,
    display: "flex",
    flexDirection: "column",
    gap: 1,
  },
  execModeMenuItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "7px 10px",
    background: "transparent",
    border: "none",
    borderRadius: 7,
    color: "var(--text-muted)",
    fontSize: 12.5,
    cursor: "pointer",
    textAlign: "left",
  },
  execModeMenuItemActive: {
    background: "var(--bg-selected, rgba(0,0,0,0.06))",
    color: "var(--text)",
    fontWeight: 600,
  },
  execModeMenuItemBlocked: {
    opacity: 0.45,
    cursor: "not-allowed",
    textDecoration: "line-through",
  },
  execModeHint: {
    fontSize: 11,
    color: "var(--accent)",
    padding: "2px 4px",
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


