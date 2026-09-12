"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, CustomMessage, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage } from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, splitFinalAssistantBlocks } from "@/lib/message-display";
import { MessageView } from "./MessageView";
import { ChangedFilesCard } from "./ChangedFilesCard";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { TodoPanel } from "./percho/TodoPanel";
import { MessageList as PerchoMessageList } from "./percho/MessageList";
import { NotionToc } from "./percho/NotionToc";
import { useTheme } from "@/hooks/useTheme";
import { extractChangedFiles } from "@/lib/changed-files";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionStatsInfo } from "@/lib/pi-types";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getVisibleRenderWindow,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenWebUrl?: (url: string) => void;
  onOpenChangedFile?: (filePath: string) => void;
  /** Content-search jump target: scroll to this entry once it is rendered. */
  jumpTarget?: { entryId: string; nonce: number } | null;
  /** Pending sheet-edit context (set by the "AI 编辑" button). */
  aiEditContext?: { file: string; prompt: string } | null;
  onAiEditContextConsumed?: () => void;
  /** Notion 式全宽：会话内容（消息流/输入框）去掉 820px 居中列宽限制 */
  fullWidth?: boolean;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return null;
}

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;
const CHAT_INPUT_RIGHT_PADDING = CHAT_COLUMN_PADDING + CHAT_MINIMAP_WIDTH;

/** percho 消息流开关：true = percho MessageList（平滑流式/折叠组），false = 旧 MessageView */
const USE_PERCHO_MESSAGE_LIST = true;

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const idx of indices) {
    const msg = messages[idx];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* Spreadsheet attachment upload (.xlsx / .univer)                     */
/* ------------------------------------------------------------------ */

interface UploadsResponse {
  uploaded?: Array<{ name: string; path: string; size: number; kind: string }>;
  errors?: Array<{ name: string; error: string }>;
  error?: string;
}

function uploadAttachments(files: File[]): Promise<{ status: number; data: UploadsResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/uploads");
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadsResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadsResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

// A user message normally anchors a turn (user prompt → process → final
// answer), and the process messages in between get folded into a collapsed
// ProcessDetailsGroup. When compaction fires mid-turn, pi drops the original
// user prompt and inserts a compaction summary (role "custom", customType
// "compaction") in its place; the agent then keeps producing tool calls and a
// final answer with no user message left to anchor them. Treat a compaction
// summary as an anchor too, otherwise every post-compaction message renders
// standalone and never collapses.
function isGroupAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

function ProcessDetailsGroup({ messageCount, toolCallCount, children, t }: { messageCount: number; toolCallCount: number; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(false);
  const parts = [t("chat.processDetails"), `${messageCount} ${t(messageCount === 1 ? "chat.message" : "chat.messages")}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${t(toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onOpenFile, onOpenWebUrl, onOpenChangedFile, jumpTarget, aiEditContext, onAiEditContextConsumed, fullWidth = false }: Props) {
  const { t } = useI18n();
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const isMobile = useIsMobile();
  const { isDark } = useTheme();

  /** percho 消息流模式：ChatMinimap/NotionToc/滚动容器样式的统一开关 */
  const perchoActive = USE_PERCHO_MESSAGE_LIST && Boolean(session?.id);

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const soundedExtensionDialogIdRef = useRef<string | null>(null);
  const wrappedOnAgentEnd = useCallback(() => {
    if (soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [onAgentEnd]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((content: string) => {
    chatInputRef?.current?.insertIfEmpty(content);
  }, [chatInputRef]);

  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    planMode, planStages,
    visionProxyStatus,
    visionModels, visionModelSelected, handleVisionModelChange,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase,
    isNew,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands,
    handlePlanModeChange, handleExecutePlan, handleExecutePlanStep,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd: wrappedOnAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  });
  const sessionBusy = agentRunning || bashRunning;

  useEffect(() => {
    if (!extensionDialog || soundedExtensionDialogIdRef.current === extensionDialog.id) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    playDoneSoundRef.current();
  }, [extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const [msgFollowing, setMsgFollowing] = useState(true);
  // percho 消息流默认只渲染最近 N 行（历史窗口化）；跳转/搜索前先展开全部，否则目标行未挂载。
  const [perchoRevealAllNonce, setPerchoRevealAllNonce] = useState(0);
  const revealAllPerchoRows = useCallback(() => setPerchoRevealAllNonce((n) => n + 1), []);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);
  const handledJumpNonceRef = useRef<number | null>(null);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          // Save distance from top before prepending to restore scroll later
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          setVisibleCount((prev) => getNextVisibleCount(prev));
        }
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, messages.length, scrollContainerRef]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);

  // Content-search jump: reveal and scroll to the target entry.
  useEffect(() => {
    if (!jumpTarget) return;
    // Only handle each nonce once; messages keep loading as the session hydrates.
    if (handledJumpNonceRef.current === jumpTarget.nonce) return;
    const entryId = jumpTarget.entryId;
    if (!entryId) return;
    const doScroll = () => {
      // Already handled by a sibling poll loop — stop.
      if (handledJumpNonceRef.current === jumpTarget.nonce) return true;
      const container = scrollContainerRef.current;
      if (!container) return false;
      const el = container.querySelector(`[data-entry-id="${CSS.escape(entryId)}"]`);
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      handledJumpNonceRef.current = jumpTarget.nonce;
      return true;
    };
    if (doScroll()) return;
    setVisibleCount((cur) => Math.max(cur, messages.length * 2));
    // percho 流同样需要取消行窗口，否则早先的消息根本没挂载，querySelector 永远找不到
    setPerchoRevealAllNonce((n) => n + 1);
    // Cross-session jumps arrive before the new session's messages load; the
    // effect re-runs when `messages` changes, and this loop also polls frames.
    let tries = 0;
    const tick = () => {
      if (doScroll()) return;
      if (tries++ < 80) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [jumpTarget, messages, scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  // Unified file upload: files land in the dedicated uploads store
  // (default <project>/pi-web-uploads, configurable), then open in the right
  // panel so the user can review them (and hit "AI 编辑" on .xlsx files).
  const [fileUploadBusy, setFileUploadBusy] = useState(false);
  const [fileUploadError, setFileUploadError] = useState<string | null>(null);
  const handleUploadFiles = useCallback(async (files: File[]) => {
    if (!files.length || fileUploadBusy) return;
    setFileUploadError(null);
    setFileUploadBusy(true);
    try {
      const { status, data } = await uploadAttachments(files);
      if (status < 200 || status >= 300) {
        const failed = data.errors?.[0];
        throw new Error(failed ? `${failed.name}: ${failed.error}` : (data.error ?? `Upload failed (HTTP ${status})`));
      }

      const uploaded = data.uploaded ?? [];
      for (const entry of uploaded) {
        if (entry.path) onOpenFile?.(entry.path);
      }
    } catch (error) {
      setFileUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setFileUploadBusy(false);
    }
  }, [fileUploadBusy, onOpenFile]);

  const onDrop = useCallback((files: File[]) => {
    if (sessionBusy) return;
    const images = files.filter((f) => f.type.startsWith("image/"));
    const others = files.filter((f) => !f.type.startsWith("image/"));
    if (images.length) chatInputRef?.current?.addImages(images);
    if (others.length) void handleUploadFiles(others);
  }, [sessionBusy, chatInputRef, handleUploadFiles]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const messageRefs = useMessageRefs(visibleMessages.length);
  const revealHistoryForMinimap = useCallback(() => {
    setVisibleCount((current) => Math.max(current, messages.length * 2));
  }, [messages.length]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;

  // 派生数据缓存（修复流式卡顿主因之一）：IIFE 渲染循环原先每帧重算
  // toolResultsMap / lastUserIdx / lastAnchorIdx / visibleRefIndexByMessage /
  // showTimestamp（后者 O(n²)）——流式期间每 token 一次 render，长会话每帧全量
  // 重建这些 Map/Set。流式增量在 streamState、messages 引用稳定 → memo 命中，
  // 重算只在消息数组真变时发生。（必须在所有提前 return 之前调用 —— hooks 规则）
  const chatDerived = useMemo(() => {
    const toolResultsMap = new Map<string, ToolResultMessage>();
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        toolResultsMap.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }

    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUserIdx = i; break; }
    }
    // Anchor for live-tail detection: the last user message, or a compaction
    // summary when compaction has replaced it mid-turn.
    let lastAnchorIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isGroupAnchor(messages[i])) { lastAnchorIdx = i; break; }
    }

    const visibleRefIndexByMessage = new Map<number, number>();
    let refIdx = 0;
    messages.forEach((msg, idx) => {
      if (msg.role === "user" || msg.role === "assistant") {
        visibleRefIndexByMessage.set(idx, refIdx++);
      }
    });

    // 每条 assistant 是否展示时间戳（原逻辑在 renderMessage 内对每条消息向后扫描，
    // 总 O(n²)；同样仅在 memo 重算时发生一次）。与原逻辑严格等价，不做裁剪。
    const showTimestampByIdx = new Set<number>();
    for (let idx = 0; idx < messages.length; idx++) {
      if (messages[idx].role !== "assistant") continue;
      let show = true;
      for (let j = idx + 1; j < messages.length; j++) {
        const r = messages[j].role;
        if (r === "user") break;
        if (r === "assistant") { show = false; break; }
      }
      if (show) showTimestampByIdx.add(idx);
    }
    return { toolResultsMap, lastUserIdx, lastAnchorIdx, visibleRefIndexByMessage, showTimestampByIdx };
  }, [messages]);

  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  // Prepend the pending sheet-edit context to the user's next message, so the
  // "AI 编辑" prompt never sits in the input box (where it could be deleted).
  // 透传 handleSend 的返回值：false = 消息未发送，输入框需要恢复内容。
  const sendWithAiEditContext = useCallback((message: string, images?: Parameters<typeof handleSend>[1]) => {
    if (aiEditContext) {
      const combined = `${aiEditContext.prompt}\n\n${message}`;
      onAiEditContextConsumed?.();
      return handleSend(combined, images);
    }
    return handleSend(message, images);
  }, [aiEditContext, handleSend, onAiEditContextConsumed]);

  const handleRevisePlan = useCallback(() => {
    chatInputRef?.current?.focus();
  }, [chatInputRef]);

  const planDoneCount = planStages.filter((stage) => stage.done).length;
  const planCardSessionId = session?.id ?? sessionIdRef.current ?? null;
  // 计划面板只在「计划模式」或「刚批准过、正在执行的计划」下出现。
  // 普通会话里模型若残留过计划阶段（历史消息），不再弹面板——否则等于把计划模式混进普通会话。
  const planSignature = planStages.map((stage) => `${stage.step}:${stage.text}`).join("|");
  const [activeRunSignature, setActiveRunSignature] = useState<string | null>(null);
  // 只在新一轮计划开始（进入计划模式）或切换会话时清除上轮的执行态，
  // 不能在「执行开始时 planMode 变 false」的同一渲染里清除，否则执行卡会立刻消失。
  const prevPlanModeRef = useRef(planMode);
  const prevPlanSessionRef = useRef(planCardSessionId);
  useEffect(() => {
    if (planMode && !prevPlanModeRef.current) setActiveRunSignature(null);
    prevPlanModeRef.current = planMode;
    if (prevPlanSessionRef.current !== planCardSessionId) {
      prevPlanSessionRef.current = planCardSessionId;
      setActiveRunSignature(null);
    }
  }, [planMode, planCardSessionId]);
  const showExecutingPlan = !planMode
    && activeRunSignature !== null && activeRunSignature === planSignature
    && planDoneCount < planStages.length
    && (planDoneCount > 0 || sessionBusy);
  const executePlanWithCard = useCallback((steps: number[]) => {
    setActiveRunSignature(planSignature);
    void handleExecutePlan(steps);
  }, [handleExecutePlan, planSignature]);
  const executePlanStepWithCard = useCallback((step: number) => {
    setActiveRunSignature(planSignature);
    void handleExecutePlanStep(step);
  }, [handleExecutePlanStep, planSignature]);
  const planCard = planMode
    ? (planStages.length > 0 && !sessionBusy
        ? <PlanApprovalCard stages={planStages} mode="plan" busy={sessionBusy} sessionId={planCardSessionId} onExecute={executePlanWithCard} onRunStep={executePlanStepWithCard} onRevise={handleRevisePlan} />
        : null)
    : (showExecutingPlan
        ? <PlanApprovalCard stages={planStages} mode="executing" busy={sessionBusy} sessionId={planCardSessionId} onExecute={executePlanWithCard} onRunStep={executePlanStepWithCard} />
        : null);

  const chatInputElement = (
    <ChatInput
      ref={chatInputRef}
      fullWidth={fullWidth}
      onSend={sendWithAiEditContext}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
      modelScopeWarnings={modelScopeWarnings}
      onModelChange={handleModelChange}
      onCompact={session || isNew ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      toolPreset={toolPreset}
      onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
      planMode={planMode}
      onPlanModeChange={session || isNew ? handlePlanModeChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinSlashCommand}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
      cwd={session?.cwd ?? newSessionCwd}
      visionProxyStatus={visionProxyStatus}
      visionModels={visionModels}
      visionModelSelected={visionModelSelected}
      onVisionModelChange={handleVisionModelChange}
      onUploadFiles={handleUploadFiles}
      onOpenInPanel={onOpenFile}
      fileUploadBusy={fileUploadBusy}
      fileUploadError={fileUploadError}
    />
  );

  // 扩展 UI 请求（含 ask_user 选择）：Codex 式内联卡片，紧贴输入框上方，不用居中弹窗
  const extensionDialogElement = extensionDialog ? (
    <ExtensionDialog request={extensionDialog} onRespond={respondToExtensionUi} />
  ) : null;

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
         {t("chat.loadingSession")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-w-0 flex-col overflow-hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && !sessionBusy && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(78,173,104,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(78,173,104,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(78,173,104,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(78,173,104,0.08)" stroke="rgba(78,173,104,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(78,173,104,0.16)" stroke="rgba(78,173,104,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(78,173,104,0.22)" stroke="rgba(78,173,104,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(78,173,104,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {isEmptyNew ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className={fullWidth ? "w-[85%] ml-[5%] mr-[10%]" : "w-full max-w-[820px]"}>
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, flex: 1, lineHeight: 1.4, overflow: "hidden" }}>
                <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: 0, color: "var(--text)", flexShrink: 0, whiteSpace: "nowrap" }}>π</span>
                <span style={{ fontSize: 22, color: "var(--text)", fontWeight: 700, letterSpacing: 0, flexShrink: 0, whiteSpace: "nowrap" }}>Pi Studio</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  pi <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</span>
                </span>
              </div>
            </div>
            <NoticeShelf notices={notices} align="right" />
            {extensionDialogElement}
            {chatInputElement}
          </div>
        </div>
      ) : (
      <>
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: isMobile || perchoActive ? 0 : CHAT_MINIMAP_WIDTH,
            zIndex: 40,
            padding: fullWidth ? 0 : `0 ${CHAT_COLUMN_PADDING}px`,
            pointerEvents: "none",
          }}
        >
          <div style={fullWidth ? { width: "85%", marginLeft: "5%", marginRight: "10%" } : { maxWidth: 820, margin: "0 auto" }}>
            <NoticeShelf notices={notices} floating align="right" />
          </div>
        </div>
        <div
          ref={scrollContainerRef}
          className={perchoActive
            ? "chat-scrollbar relative z-10 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
            : "min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]"}
        >
          <div style={{ minWidth: 0, height: perchoActive ? "100%" : undefined, padding: fullWidth ? 0 : `0 ${CHAT_COLUMN_PADDING}px` }}>
            {/* 全宽：内容占 85%，左 5% / 右 10%（右侧留白避开 NotionToc 目录条） */}
            <div style={{ minWidth: 0, height: perchoActive ? "100%" : undefined, ...(fullWidth ? { width: "85%", marginLeft: "5%", marginRight: "10%" } : { width: "100%", maxWidth: 820, margin: "0 auto" }) }}>
              <ExtensionWidgets widgets={aboveEditorWidgets} />

            {perchoActive && session ? (
              <PerchoMessageList
                sessionId={session.id}
                isDark={isDark}
                onOpenSubagent={(file) => onOpenFile?.(file)}
                fullWidth={fullWidth}
                scrollContainerRef={scrollContainerRef}
                cwd={messageCwd}
                onOpenFile={onOpenFile}
                onOpenWebUrl={onOpenWebUrl}
                following={msgFollowing}
                onFollowingChange={setMsgFollowing}
                revealAllNonce={perchoRevealAllNonce}
              />
            ) : (
              <>

            {(() => {
              // 派生数据（toolResultsMap/lastUserIdx/lastAnchorIdx/visibleRefIndexByMessage）
              // 已提升到组件顶层的 chatDerived useMemo —— 流式期间不再每帧重算。
              const { toolResultsMap, lastUserIdx, lastAnchorIdx, visibleRefIndexByMessage } = chatDerived;

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
                if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                    ? entryIds[idx - 1]
                    : undefined;
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const keyPrefix = options.keyPrefix ?? "message";
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  // 向后扫描已提升到 chatDerived 的 showTimestampByIdx（O(n²)→查表）
                  showTimestamp = chatDerived.showTimestampByIdx.has(idx);
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
                const view = (
                  <MessageView
                    key={`${keyPrefix}-view-${idx}`}
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    onOpenWebUrl={onOpenWebUrl}
                    entryId={entryIds[idx]}
                    onFork={sessionBusy || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={sessionBusy ? undefined : handleNavigate}
                    prevAssistantEntryId={sessionBusy ? undefined : prevAssistantEntryId}
                    onEditContent={handleEditContent}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                  />
                );
                if (!isVisible || options.attachRef === false || currentRefIdx === undefined) return view;
                return (
                  <div key={`${keyPrefix}-${idx}`} ref={attachVisibleRef(idx, currentRefIdx)} data-entry-id={entryIds[idx]}>
                    {view}
                  </div>
                );
              };

              const rendered: ReactNode[] = [];
              for (let idx = 0; idx < messages.length;) {
                const msg = messages[idx];
                if (!isGroupAnchor(msg)) {
                  rendered.push(renderMessage(idx));
                  if (msg.role === "assistant") {
                    const msgBlocks = (msg as AssistantMessage).content ?? [];
                    const changedFiles = extractChangedFiles(msgBlocks, messageCwd);
                    if (changedFiles.length > 0) {
                      rendered.push(
                        <div key={`changed-${idx}`} style={{ marginBottom: 16 }}>
                          <ChangedFilesCard files={changedFiles} cwd={messageCwd} onOpenFile={onOpenChangedFile} />
                        </div>,
                      );
                    }
                  }
                  idx += 1;
                  continue;
                }

                const userIdx = idx;
                let endIdx = userIdx + 1;
                while (endIdx < messages.length && !isGroupAnchor(messages[endIdx])) endIdx += 1;

                const finalAssistantIdx = findFinalAssistantIndex(messages, userIdx, endIdx);

                if (finalAssistantIdx === -1) {
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                  }
                  idx = endIdx;
                  continue;
                }

                const isLiveTail = (sessionBusy || streamState.isStreaming) && endIdx === messages.length && userIdx === lastAnchorIdx;
                if (isLiveTail) {
                  for (let renderIdx = userIdx; renderIdx < endIdx; renderIdx++) {
                    rendered.push(renderMessage(renderIdx));
                    const liveMsg = messages[renderIdx];
                    if (liveMsg?.role === "assistant") {
                      const liveBlocks = (liveMsg as AssistantMessage).content ?? [];
                      const liveChanged = extractChangedFiles(liveBlocks, messageCwd);
                      if (liveChanged.length > 0) {
                        rendered.push(
                          <div key={`changed-live-${renderIdx}`} style={{ marginBottom: 16 }}>
                            <ChangedFilesCard files={liveChanged} cwd={messageCwd} onOpenFile={onOpenChangedFile} />
                          </div>,
                        );
                      }
                    }
                  }
                  idx = endIdx;
                  continue;
                }

                rendered.push(renderMessage(userIdx));

                const processIndices: number[] = [];
                for (let processIdx = userIdx + 1; processIdx < finalAssistantIdx; processIdx++) {
                  processIndices.push(processIdx);
                }
                const visibleProcessIndices = processIndices.filter((processIdx) => hasDisplayableProcessMessage(messages[processIdx]));
                const finalAssistant = messages[finalAssistantIdx] as AssistantMessage;
                const finalSplit = splitFinalAssistantBlocks(finalAssistant);
                const finalProcessMessage = finalSplit.processBlocks.length > 0
                  ? withAssistantBlocks(finalAssistant, finalSplit.processBlocks, { omitUsage: true })
                  : null;
                const finalAnswerMessage = finalSplit.answerBlocks.length > 0 || getAssistantErrorMessage(finalAssistant)
                  ? withAssistantBlocks(finalAssistant, finalSplit.answerBlocks)
                  : null;

                const processCount = visibleProcessIndices.length + (finalProcessMessage ? 1 : 0);
                if (processCount > 0) {
                  const processRefIdx = visibleProcessIndices
                    .map((processIdx) => visibleRefIndexByMessage.get(processIdx))
                    .find((value): value is number => typeof value === "number")
                    ?? (finalAnswerMessage ? undefined : visibleRefIndexByMessage.get(finalAssistantIdx));
                  const processGroup = (
                    <ProcessDetailsGroup
                       messageCount={processCount}
                       t={t}
                      toolCallCount={countToolCalls(messages, visibleProcessIndices) + countToolCallBlocks(finalSplit.processBlocks)}
                    >
                      {visibleProcessIndices.map((processIdx) => renderMessage(processIdx, { attachRef: false, keyPrefix: "process" }))}
                      {finalProcessMessage && renderMessage(finalAssistantIdx, { attachRef: false, keyPrefix: "process-final", messageOverride: finalProcessMessage, showTimestamp: false })}
                    </ProcessDetailsGroup>
                  );
                  rendered.push(
                    <div
                      key={`process-group-${userIdx}-${finalAssistantIdx}`}
                      ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                    >
                      {processGroup}
                    </div>,
                  );
                }

                if (finalAnswerMessage) {
                  rendered.push(renderMessage(finalAssistantIdx, { messageOverride: finalAnswerMessage }));
                }
                // Changed/generated files are gathered from ALL assistant messages in
                // the group into one unified card — edit/write tool calls happen in
                // the process messages (folded into ProcessDetailsGroup), not in the
                // final answer.
                const groupBlocks: AssistantContentBlock[] = [];
                for (let gi = userIdx + 1; gi < endIdx; gi++) {
                  const gm = messages[gi];
                  if (gm?.role === "assistant") groupBlocks.push(...((gm as AssistantMessage).content ?? []));
                }
                const changedFiles = extractChangedFiles(groupBlocks, messageCwd);
                if (changedFiles.length > 0) {
                  rendered.push(
                    <div key={`changed-${userIdx}-${finalAssistantIdx}`} style={{ marginBottom: 16 }}>
                      <ChangedFilesCard files={changedFiles} cwd={messageCwd} onOpenFile={onOpenChangedFile} />
                    </div>,
                  );
                }
                for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                  rendered.push(renderMessage(renderIdx));
                }
                idx = endIdx;
              }
              const { startIndex, hasMore } = getVisibleRenderWindow(rendered.length, visibleCount);
              return (
                <>
                  {hasMore && (
                     <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
                       {t("chat.loadEarlier", { count: startIndex })}
                    </div>
                  )}
                  {rendered.slice(startIndex)}
                </>
              );
            })()}
            {streamState.isStreaming && streamState.streamingMessage && (
              <>
              <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} cwd={messageCwd} onOpenFile={onOpenFile} />
              {(() => {
                const sm = streamState.streamingMessage;
                if (sm?.role !== "assistant") return null;
                const liveBlocks = (sm as AssistantMessage).content ?? [];
                const liveChanged = extractChangedFiles(liveBlocks, messageCwd);
                const cards: ReactNode[] = [];
                if (liveChanged.length > 0) {
                  cards.push(
                    <div key="changed" style={{ marginBottom: 16 }}>
                      <ChangedFilesCard files={liveChanged} cwd={messageCwd} onOpenFile={onOpenChangedFile} />
                    </div>,
                  );
                }
                return cards.length > 0 ? <>{cards}</> : null;
              })()}
              </>
            )}

            {agentRunning && !streamState.streamingMessage && agentPhase && (
              <div className="py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
              />
            )}

            {agentRunning && (
              <div style={{ height: scrollContainerRef.current ? scrollContainerRef.current.clientHeight : "80vh" }} />
            )}

            <div ref={messagesEndRef} />
            </>
            )}
            </div>
          </div>
        </div>
        {/* 常驻回到底部按钮：挂在消息区（相对非滚动容器）absolute 定位，滚动时不会随内容消失 */}
        {perchoActive && session && (
          <button
            type="button"
            onClick={() => {
              const el = scrollContainerRef.current;
              setMsgFollowing(true);
              if (el)
                el.scrollTo({
                  top: el.scrollHeight,
                  behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                });
            }}
            className={`percho-fab pointer-events-auto absolute bottom-4 left-1/2 z-20 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full text-ink-2 ${
              msgFollowing ? "opacity-70 hover:opacity-100" : "opacity-100"
            }`}
            aria-label={t("message.scrollToBottom")}
            title={t("message.scrollToBottom")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
          </button>
        )}
        {/* percho 模式下旧 ChatMinimap 由 NotionToc（Notion 风格目录，贴消息区最右缘）取代 */}
        {!isMobile && perchoActive && session && (
          <NotionToc sessionId={session.id} scrollRef={scrollContainerRef} />
        )}
        {isMobile || perchoActive ? null : (
          <ChatMinimap
            messages={messages}
            streamingMessage={streamState.streamingMessage}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
            onRevealHistory={revealHistoryForMinimap}
          />
        )}
        {!isMobile && <TodoPanel sessionId={session?.id ?? null} />}
      </div>

      <div className="relative">
        <div
          style={{
            padding: fullWidth ? 0 : `0 ${CHAT_COLUMN_PADDING}px`,
            paddingRight: fullWidth ? 0 : isMobile ? CHAT_COLUMN_PADDING : CHAT_INPUT_RIGHT_PADDING,
          }}
        >
          <div style={fullWidth ? { width: "85%", marginLeft: "5%", marginRight: "10%" } : { maxWidth: 820, margin: "0 auto" }}>
            <ExtensionWidgets widgets={belowEditorWidgets} />
          </div>
        </div>
        {aiEditContext && (
          <div style={{ margin: "0 auto 8px", padding: "0 16px", ...(fullWidth ? { width: "85%", marginLeft: "5%", marginRight: "10%" } : { maxWidth: 820 }) }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: "var(--radius-sm)", background: "rgba(78,173,104,0.08)", border: "1px solid rgba(78,173,104,0.22)", color: "var(--text)", fontSize: 12 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }}>
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <path d="M3 9h18" />
                <path d="M3 15h18" />
                <path d="M9 3v18" />
              </svg>
              <span style={{ flex: 1, minWidth: 0 }}>{t("chat.aiEditHint")}</span>
              <button
                type="button"
                onClick={onAiEditContextConsumed}
                title={t("i18n.close")}
                aria-label={t("i18n.close")}
                style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, background: "none", border: "none", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <line x1="2" y1="2" x2="8" y2="8" />
                  <line x1="8" y1="2" x2="2" y2="8" />
                </svg>
              </button>
            </div>
          </div>
        )}
        {session && (
          <SessionStatusChip
            session={session}
            sessionStats={sessionStats}
            contextUsage={contextUsage}
            running={sessionBusy}
            t={t}
            fullWidth={fullWidth}
            onOpen={() => onSessionStatsPanelOpen?.()}
          />
        )}
        {planCard}
        {extensionDialogElement}
        {chatInputElement}
        <ExtensionStatusBar statuses={extensionStatuses} />
      </div>
      </>
      )}
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "5px 9px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {widget.key}
          </div>
          <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
            {widget.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}

function NoticeShelf({ notices, floating = false, align = "left" }: { notices: NoticeItem[]; floating?: boolean; align?: "left" | "right" }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minHeight: 60,
              height: 60,
              maxHeight: 60,
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: "var(--radius-lg)",
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg-elevated)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 18,
              lineHeight: 1.45,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
              }}
            />
            <span style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div style={{ margin: "0 auto 8px", maxWidth: 820, padding: "0 16px", width: "100%" }}>
      <div
        role="dialog"
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          background: "var(--bg-panel)",
          boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -18px rgba(15,23,42,0.35)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{t("chat.extensionRequest")}</div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
                if (e.key === "Escape") onRespond(request, { cancelled: true });
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") onRespond(request, { cancelled: true });
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: "var(--radius-xs)",
              border: "1px solid var(--border)",
              background: "var(--bg-elevated)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: "var(--radius-xs)",
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: "var(--radius-xs)",
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0,0,0,0.18)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg-elevated)",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: "var(--radius-xs)",
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
             {t("chat.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}


function SessionStatusChip({ session, sessionStats, contextUsage, running, t, fullWidth, onOpen }: {
  session: SessionInfo | null;
  sessionStats: SessionStatsInfo | null;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  running: boolean;
  t: (k: string) => string;
  fullWidth: boolean;
  onOpen: () => void;
}) {
  const name = session
    ? (session.teamName || session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12))
    : "";
  const tokens = sessionStats?.tokens;
  const c = sessionStats?.cost ?? 0;
  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
  const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;
  let ctxStr: string | null = null;
  let ctxColor = "var(--text-muted)";
  if (contextUsage?.contextWindow) {
    const pct = contextUsage.percent;
    if (pct !== null && pct > 90) ctxColor = "#ef4444";
    else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
    ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
  }

  const hasMeta = Boolean(
    (tokens && (tokens.input > 0 || tokens.output > 0)) || costStr || ctxStr,
  );
  if (!hasMeta) return null;

  return (
    <button
      onClick={onOpen}
      title={name ? `${name}\n${t("session.title")}` : t("session.title")}
      aria-label={t("session.title")}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        flexWrap: "wrap", justifyContent: "center",
        width: fullWidth ? "85%" : "100%",
        maxWidth: fullWidth ? "none" : 820,
        marginLeft: fullWidth ? "5%" : "auto",
        marginRight: fullWidth ? "10%" : "auto",
        marginTop: 0,
        marginBottom: 6,
        padding: "3px 10px",
        background: "none", border: "none", borderRadius: "var(--radius-xs)",
        color: "var(--text-muted)", cursor: "pointer",
        fontSize: 12, fontVariantNumeric: "tabular-nums",
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
    >
      {running ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      ) : (
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--border)", flexShrink: 0 }} />
      )}
      {tokens && tokens.input > 0 && (
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" /></svg>
          {fmt(tokens.input)}
        </span>
      )}
      {tokens && tokens.output > 0 && (
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" /></svg>
          {fmt(tokens.output)}
        </span>
      )}
      {costStr && <span style={{ color: "var(--text)", fontWeight: 500 }}>{costStr}</span>}
      {ctxStr && <span style={{ color: ctxColor }}>ctx {ctxStr}</span>}
    </button>
  );
}
