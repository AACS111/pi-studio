"use client";

import { useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { messageSearchText, excerpt } from "@/lib/message-search";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { FileBrowserPanel } from "./FileBrowserPanel";
import { ChatWorkspace } from "./ChatWorkspace";
import { FileViewer } from "./FileViewer";
import { WebViewer } from "./WebViewer";
import { TabBar, type Tab } from "./TabBar";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { UploadsManager } from "./UploadsManager";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { ActivityBar, type Activity } from "./ActivityBar";
import { CommandPalette, type PaletteMode } from "./CommandPalette";
import { SkillsPanel } from "./SkillsPanel";
import { TerminalPanel } from "./TerminalPanel";
import { SettingsPanel } from "./SettingsPanel";
import { WindowControls } from "./WindowControls";
import { GlowBackground } from "./GlowBackground";
import { useTheme } from "@/hooks/useTheme";
import { useAccentColor } from "@/hooks/useAccentColor";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { copyText } from "@/lib/clipboard";
import { getFileName } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import {
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  RIGHT_PANEL_ABSOLUTE_MAX_WIDTH,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";
import type { SessionInfo, SessionTreeNode, AgentMessage } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";

type SessionCopyField = "file" | "id";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

// 任务区「文件/表格」卡片点击后选择本地文件打开：Electron 桥（preload.cjs）
// 提供 pi-pick-open-file 原生对话框；纯浏览器模式退化为 <input type=file> 上传副本。
interface PiElectronPickApi {
  pickOpenFile?: (opts: {
    title?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ canceled: boolean; filePath: string | null; error?: string }>;
}

function getNativePickApi(): PiElectronPickApi["pickOpenFile"] | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { piElectron?: PiElectronPickApi }).piElectron?.pickOpenFile;
}

type HomeCardPickKind = "files" | "sheets";

const TOP_BAR_ICON_BUTTON_SIZE = 36;

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}



/** Used for the terminal tab inside the unified file bar. */
const TERMINAL_TAB_ID = "terminal:main";

// Per-project right-panel memory (module-scoped so it survives an AppShell
// remount, and mirrored to sessionStorage so it survives a full page reload).
// AppShell is wrapped in <Suspense> and calls useSearchParams(); switching
// sessions does router.replace("?session=…"), which remounts the shell and
// resets component-local state — so the panel must be restored from here.
type PanelSnapshot = {
  fileTabs: Tab[];
  activeFileTabId: string | null;
  rightPanelOpen: boolean;
  rightPanelMode: "home" | "files";
  terminalOpen: boolean;
};

const PANEL_MEMORY_STORAGE_KEY = "pi.panelMemory.v1";
const panelMemoryByProject = new Map<string, PanelSnapshot>();

function loadPanelMemory() {
  try {
    if (typeof sessionStorage === "undefined") return;
    const raw = sessionStorage.getItem(PANEL_MEMORY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, PanelSnapshot>;
    for (const [k, v] of Object.entries(parsed)) {
      if (v && Array.isArray(v.fileTabs)) panelMemoryByProject.set(k, v);
    }
  } catch {
    // ignore corrupt/denied storage
  }
}

function savePanelMemory() {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(
      PANEL_MEMORY_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(panelMemoryByProject)),
    );
  } catch {
    // ignore quota/denied storage
  }
}

loadPanelMemory();

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { isDark, toggleTheme } = useTheme();
  // Apply the persisted accent color (preset or custom) as CSS variables.
  useAccentColor();
  // Electron window controls (— □ ×) are rendered by <WindowControls/> inside
  // the center top bar — there is no separate title-bar layer.
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const isMobile = useIsMobile();
  useViewportHeight();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [pluginsConfigOpen, setPluginsConfigOpen] = useState(false);
  const [uploadsManagerOpen, setUploadsManagerOpen] = useState(false);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  // Codex-style right-panel: a single unified "files" mode hosts every open
  // content tab (files, spreadsheets, browser pages, terminal) in one tab bar.
  // "home" is the Codex-style card launcher shown when the panel opens with
  // nothing to display yet — also the startup default.
  const [rightPanelMode, setRightPanelMode] = useState<"home" | "files">("home");
  // The terminal panel is a normal tab inside the unified bar, toggled here.
  const [terminalOpen, setTerminalOpen] = useState(false);
  // Declared early: handleSelectActivity reads it to decide whether opening
  // the panel should land on the card home (no content to show).
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  // Last non-home mode — clicking the grid icon while on the card home toggles
  // back to the tab view the user came from instead of trapping them there.
  const lastNonHomeModeRef = useRef<"files">("files");
  useEffect(() => {
    if (rightPanelMode !== "home") lastNonHomeModeRef.current = rightPanelMode;
  }, [rightPanelMode]);
  const [rightPanelMaximized, setRightPanelMaximized] = useState(false);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  // First-level activity (一级导航) — the second column swaps its content.
  const [activeActivity, setActiveActivity] = useState<Activity>("sessions");
  // Reported by the always-mounted SessionSidebar for the activity-bar dot.
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());
  const [unreadSessionCount, setUnreadSessionCount] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("all");
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);
  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanelResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFilePanel"),
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_ABSOLUTE_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const setSidebarWidth = sidebarResizer.setWidthTo;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);
  // Maximize state: resets when the panel closes; Esc restores the split.
  useEffect(() => {
    if (!rightPanelOpen) setRightPanelMaximized(false);
  }, [rightPanelOpen]);
  useEffect(() => {
    if (!rightPanelMaximized) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      setRightPanelMaximized(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rightPanelMaximized]);
  const handleToggleRightPanelMaximize = useCallback(() => {
    setRightPanelMaximized((v) => !v);
  }, []);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Single active top panel — the session stats dropdown under the top bar
  const [activeTopPanel, setActiveTopPanel] = useState<"session" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  // Refs for the top panel + its toggle buttons so clicks inside them don't close it.
  const topPanelRef = useRef<HTMLDivElement>(null);
  const sessionToggleRef = useRef<HTMLButtonElement>(null);
  const statsToggleRef = useRef<HTMLButtonElement>(null);

  // Pending sheet-edit context set by the "AI 编辑" button. It is prepended
  // to the user's next message instead of being left in the input box.
  const [aiEditContext, setAiEditContext] = useState<{ file: string; prompt: string } | null>(null);

  // Content search (within the current session)
  const [contentSearchOpen, setContentSearchOpen] = useState(false);
  const [contentSearchQuery, setContentSearchQuery] = useState("");
  const [contentSearchResults, setContentSearchResults] = useState<Array<{ entryId: string; role: string; text: string }>>([]);
  const [contentSearchLoading, setContentSearchLoading] = useState(false);
  const [contentSearchActiveIdx, setContentSearchActiveIdx] = useState(-1);
  const [jumpTarget, setJumpTarget] = useState<{ entryId: string; nonce: number } | null>(null);
  // Notion 式全宽会话区（顶栏 ⇔ 按钮切换，localStorage 持久化）
  const [chatFullWidth, setChatFullWidth] = useState(false);
  const contentSearchAbortRef = useRef<AbortController | null>(null);
  const contentSearchBtnRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentSearchResultsRef = useRef<HTMLDivElement>(null);
  const contentSearchOpenRef = useRef(false);
  const showChatRef = useRef(false);
  contentSearchOpenRef.current = contentSearchOpen;
  const [contentSearchPos, setContentSearchPos] = useState<{ top: number; right: number } | null>(null);

  // 全宽会话区：挂载后恢复上次选择（useEffect 读取，避免 SSR 注水不匹配）
  useEffect(() => {
    try {
      if (window.localStorage.getItem("pi-web:chat-full-width") === "1") setChatFullWidth(true);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem("pi-web:chat-full-width", chatFullWidth ? "1" : "0");
    } catch { /* ignore */ }
  }, [chatFullWidth]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null);
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  /** Toggle the right panel. Opening with nothing to show (no file/web tabs)
   *  and no live terminal session lands on the Codex-style task-card home,
   *  never a bare empty mode. Shared by the top-bar button and the activity
   *  rail / command palette so every entry point behaves the same. */
  const toggleRightPanel = useCallback(() => {
    const willOpen = !rightPanelOpen;
    setRightPanelOpen(willOpen);
    if (willOpen && fileTabs.length === 0 && !terminalOpen) {
      setRightPanelMode("home");
    }
  }, [rightPanelOpen, terminalOpen, fileTabs]);

  const handleSelectActivity = useCallback((activity: Activity) => {
    // "rightPanel" just toggles the right panel — it's a one-off action, not a mode.
    if (activity === "rightPanel") {
      toggleRightPanel();
      if (isMobile) setSidebarOpen(false);
      return;
    }
    // Clicking the already-active entry closes it and returns to sessions
    // (e.g. ⚙ settings → sessions).
    setActiveActivity((cur) => (cur === activity && activity !== "sessions" ? "sessions" : activity));
    // Switching capability should reveal the second column it controls.
    setSidebarOpen(true);
    if (isMobile) setActiveTopPanel(null);
  }, [isMobile, toggleRightPanel]);

  // Position the session stats panel under the top bar
  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const rect = topBarRef.current!.getBoundingClientRect();
      setTopPanelPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel]);

  // Close the top panel when clicking anywhere outside it (or its toggle buttons).
  useEffect(() => {
    if (!activeTopPanel) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target instanceof Node ? e.target : null;
      if (!t) return;
      if (
        topPanelRef.current?.contains(t) ||
        sessionToggleRef.current?.contains(t) ||
        statsToggleRef.current?.contains(t)
      ) {
        return;
      }
      setActiveTopPanel(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [activeTopPanel]);

  // Content search: fetch the session context and search message text.
  useEffect(() => {
    if (!contentSearchOpen || !selectedSession?.id) {
      setContentSearchResults([]);
      return;
    }
    const q = contentSearchQuery.trim();
    if (!q) {
      setContentSearchResults([]);
      setContentSearchLoading(false);
      return;
    }
    contentSearchAbortRef.current?.abort();
    const controller = new AbortController();
    contentSearchAbortRef.current = controller;
    setContentSearchLoading(true);
    void fetch(`/api/sessions/${encodeURIComponent(selectedSession.id)}/context?deferThinking=1&deferMedia=1`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (controller.signal.aborted) return;
        const messages = (data?.context?.messages ?? []) as AgentMessage[];
        const ids = (data?.context?.entryIds ?? []) as string[];
        const lower = q.toLowerCase();
        const results: Array<{ entryId: string; role: string; text: string }> = [];
        for (let i = 0; i < messages.length; i++) {
          const text = messageSearchText(messages[i]);
          if (!text || !text.toLowerCase().includes(lower)) continue;
          results.push({ entryId: ids[i] ?? "", role: messages[i].role, text });
          if (results.length >= 50) break;
        }
        setContentSearchResults(results);
      })
      .catch(() => { if (!controller.signal.aborted) setContentSearchResults([]); })
      .finally(() => { if (!controller.signal.aborted) setContentSearchLoading(false); });
    return () => controller.abort();
  }, [contentSearchOpen, contentSearchQuery, selectedSession?.id]);

  // Reset the keyboard-highlighted result whenever the result set changes.
  useEffect(() => {
    setContentSearchActiveIdx(-1);
  }, [contentSearchResults]);

  // Keep the keyboard-highlighted search result in view inside the dropdown.
  useEffect(() => {
    if (contentSearchActiveIdx < 0) return;
    const el = contentSearchResultsRef.current?.querySelector(`[data-search-idx="${contentSearchActiveIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [contentSearchActiveIdx]);

  // Position the content-search dropdown under its button.
  useEffect(() => {
    if (!contentSearchOpen || !contentSearchBtnRef.current) return;
    const update = () => {
      const rect = contentSearchBtnRef.current!.getBoundingClientRect();
      setContentSearchPos({ top: rect.bottom, right: window.innerWidth - rect.right });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(contentSearchBtnRef.current);
    return () => ro.disconnect();
  }, [contentSearchOpen]);

  // Right panel — file tabs only
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const activeProjectRootRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  // Keep the active project's snapshot fresh so a cross-project switch or an
  // AppShell remount / page reload restores the most recent panel state (see
  // the module-level panelMemoryByProject store above).
  useEffect(() => {
    const proj = activeProjectRootRef.current;
    if (!proj) return;
    panelMemoryByProject.set(proj, {
      fileTabs, activeFileTabId, rightPanelOpen, rightPanelMode, terminalOpen,
    });
    savePanelMemory();
  }, [fileTabs, activeFileTabId, rightPanelOpen, rightPanelMode, terminalOpen]);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null) => {
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const newProject = projectRoot ?? cwd;
    const currentProject = activeProjectRootRef.current
      ?? (selectedSession ? (selectedSession.projectRoot ?? selectedSession.cwd) : null);
    activeProjectRootRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    if (currentProject === newProject) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    // File tabs are keyed by absolute path, so tabs opened in the previous
    // project would otherwise linger after switching to a different project.
    // Reached only past the same-project early return above, so worktrees of
    // one repo keep their open tabs. Restore the target project's last panel
    // (kept in the module-level store, which survives an AppShell remount),
    // falling back to an empty panel only when that project has no snapshot.
    // 与 handleSelectSession 保持一致：跨项目/清空面板时也必须合并当前仍开着的浏览器
    // 标签（全局面板）。此前这里直接 setFileTabs(savedPanel.fileTabs)，会把当前 web 标签
    // 从 React 摘掉 → WebViewer 卸载 → destroyWebView → 原生视图销毁且不重建（表现为
    // 切会话后浏览器先闪现一下随即空白）。
    const savedPanel = newProject ? panelMemoryByProject.get(newProject) : undefined;
    const currentWebTabs = fileTabs.filter((t) => t.kind === "web");
    const restoredTabs = savedPanel ? savedPanel.fileTabs : [];
    const mergedTabs = [...restoredTabs];
    for (const wt of currentWebTabs) {
      if (!mergedTabs.some((t) => t.id === wt.id)) mergedTabs.push(wt);
    }
    if (savedPanel) {
      setFileTabs(mergedTabs);
      setActiveFileTabId(savedPanel.activeFileTabId);
      setRightPanelOpen(savedPanel.rightPanelOpen);
      setRightPanelMode(savedPanel.rightPanelMode);
      setTerminalOpen(savedPanel.terminalOpen);
    } else {
      setFileTabs(currentWebTabs);
      setActiveFileTabId(currentWebTabs[0]?.id ?? null);
      setRightPanelOpen(false);
    }
    router.replace("/", { scroll: false });
  }, [router, selectedSession, fileTabs]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    // 主动打开某会话 = 用户切到该会话所属项目。提前更新项目根 ref，否则随后的
    // onCwdChange 通知（点击项目行直接打开首个会话时，cwd 同步与选择在同一批次）
    // 会因 ref 还停留在旧项目而把刚打开的会话当跨项目切换关掉。
    const previousProject = activeProjectRootRef.current;
    const newProject = session.projectRoot ?? session.cwd;
    const crossingProject = previousProject != null
      && !!newProject
      && previousProject !== newProject;
    if (newProject) activeProjectRootRef.current = newProject;
    if (crossingProject) {
      // 与 handleCwdChange 的项目切换清理保持一致：旧项目的分支树/顶部面板不再适用。
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setActiveTopPanel(null);
    }
    // 恢复目标项目最近一次的面板快照（模块级 store 持久化，跨 AppShell 重挂/页面刷新
    // 都不丢）；仅当该项目从未有过快照、且确实发生了项目切换或首次挂载时才清空关面板。
    const savedPanel = newProject ? panelMemoryByProject.get(newProject) : undefined;
    // 浏览器标签跨会话保留：切会话不应毁掉用户正在看的网页。若直接 setFileTabs(savedPanel.fileTabs)
    // 覆盖，会把当前 web 标签从 React 摘掉 → WebViewer 卸载 → destroyWebView → 原生视图销毁且不重建
    //（表现为切会话后浏览器空白）。因此把当前仍开着的 web 标签合并进恢复后的标签列表。
    const currentWebTabs = fileTabs.filter((t) => t.kind === "web");
    const restoredTabs = savedPanel ? savedPanel.fileTabs : [];
    const mergedTabs = [...restoredTabs];
    for (const wt of currentWebTabs) {
      if (!mergedTabs.some((t) => t.id === wt.id)) mergedTabs.push(wt);
    }
    if (savedPanel) {
      setFileTabs(mergedTabs);
      setActiveFileTabId(savedPanel.activeFileTabId);
      setRightPanelOpen(savedPanel.rightPanelOpen);
      setRightPanelMode(savedPanel.rightPanelMode);
      setTerminalOpen(savedPanel.terminalOpen);
    } else if (previousProject !== newProject) {
      // 新项目无快照：保留浏览器标签（浏览器是全局面板），其余清空。
      setFileTabs(currentWebTabs);
      setActiveFileTabId(currentWebTabs[0]?.id ?? null);
      setRightPanelOpen(false);
    }
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    // Clear any pending content-search jump when switching sessions.
    setJumpTarget(null);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router, isMobile]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
    // 可见反馈：重置为空白会话后聚焦输入框（光标闪烁 = 新会话已就绪）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => chatInputRef.current?.focus());
    });
  }, [router, isMobile]);

  // Command-palette content match: open the session and jump to the message.
  const handleSelectContentMatch = useCallback((session: SessionInfo, entryId: string) => {
    handleSelectSession(session);
    if (entryId) setJumpTarget({ entryId, nonce: Date.now() });
  }, [handleSelectSession]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N, Ctrl+F etc.)
  const handleOpenContentSearch = useCallback(() => {
    if (!showChatRef.current) return;
    if (!contentSearchOpenRef.current) setContentSearchQuery("");
    setContentSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
    onSearchContent: handleOpenContentSearch,
    onCommandPalette: () => {
      setPaletteMode("all");
      setPaletteOpen(true);
    },
    onQuickOpen: () => {
      setPaletteMode("files");
      setPaletteOpen(true);
    },
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (prev && prev.id === sessionId && !prev.projectRoot ? full : prev));
      })
      .catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      setRefreshKey((key) => key + 1);
      if (activeSessionIdRef.current !== sessionId) return;
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router]);

  // handleOpenFile is the single entry point that appends a file/web tab.
  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; homeMode?: "files" | "sheets" },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const homeMode = options?.homeMode;
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) {
        return [...prev, {
          id: tabId,
          label: fileName,
          kind: "file",
          filePath,
          sourceSessionId,
          initialDisplayMode: modeHint,
          ...(homeMode ? { homeMode } : {}),
        }];
      }
      const sourceUnchanged = !sourceSessionId || existing.sourceSessionId === sourceSessionId;
      const modeUnchanged = !modeHint || existing.initialDisplayMode === modeHint;
      const homeUnchanged = !homeMode || existing.homeMode === homeMode;
      if (sourceUnchanged && modeUnchanged && homeUnchanged) return prev;
      return prev.map((t) => {
        if (t.id !== tabId) return t;
        const next: Tab = { ...t };
        if (sourceSessionId) next.sourceSessionId = sourceSessionId;
        if (modeHint) next.initialDisplayMode = modeHint;
        if (homeMode) next.homeMode = homeMode;
        return next;
      });
    });
    setActiveFileTabId(tabId);
    // One unified file bar hosts every content tab — spreadsheets and plain
    // files no longer live in separate, mutually-exclusive modes (previously
    // opening a file hid the open spreadsheet).
    setRightPanelMode("files");
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId: selectedSession?.id ?? null });
  }, [handleOpenFile, selectedSession?.id]);

  // Opened from the unified changed-files card: edit-kind rows show the git
  // diff view directly; write-kind (generated) rows have no diff history and
  // FileViewer falls back to the normal view for those automatically.
  const handleOpenChangedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), {
      sourceSessionId: selectedSession?.id ?? null,
      modeHint: "diff",
    });
  }, [handleOpenFile, selectedSession?.id]);

  // "AI 编辑" flow for a plain .xlsx file (button in the spreadsheet viewer):
  // 1) convert the .xlsx into a .univer via /api/univer/from-xlsx,
  // 2) open the .univer in the right panel (also updates the open-file marker
  //    so the sheet-edit skill targets it), and
  // 3) kick off the agent with a sheet-edit skill prompt.
  // Rejects with a user-facing message on failure (shown in the viewer).
  const handleAiEdit = useCallback(async (xlsxPath: string) => {
    let res: Response;
    try {
      res = await fetch("/api/univer/from-xlsx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: xlsxPath }),
      });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    const data = (await res.json().catch(() => ({}))) as { file?: string; kind?: string; error?: string };
    if (!res.ok || !data.file) {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

    // Office docs (doc/slide units) belong to the 文件 bar; spreadsheets to
    // 表格. Passing the home explicitly keeps the tab out of the other bar.
    const isOffice = data.kind === "doc" || data.kind === "slide";
    handleOpenFile(data.file, getFileName(data.file), {
      sourceSessionId: selectedSession?.id ?? null,
      homeMode: isOffice ? "files" : "sheets",
    });

    // Remember the edit context. It is prepended to the user's next message so
    // they can type their instruction directly — no prompt sits in the input
    // box where it could be deleted.
    const prompt = translate(isOffice ? "chat.officeEditPrompt" : "chat.aiEditPrompt", { file: data.file });
    setAiEditContext({ file: data.file, prompt });
  }, [handleOpenFile, selectedSession?.id, translate]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    // The terminal tab is a separate toggle, not part of fileTabs.
    if (tabId === TERMINAL_TAB_ID) {
      setTerminalOpen(false);
      setActiveFileTabId((cur) => {
        if (cur !== TERMINAL_TAB_ID) return cur;
        const pool = fileTabs;
        return pool.length > 0 ? pool[pool.length - 1].id : null;
      });
      if (fileTabs.length === 0) setRightPanelOpen(false);
      return;
    }
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0 && !terminalOpen) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      // In the unified bar the active tab succeeds to the most recent one.
      const pool = fileTabs.filter((t) => t.id !== tabId);
      return pool.length > 0 ? pool[pool.length - 1].id : null;
    });
  }, [fileTabs, terminalOpen]);

  // ---- 任务区卡片：选择本地文件打开（Electron 原生对话框；浏览器模式上传副本） ----

  const [homePickError, setHomePickError] = useState<string | null>(null);
  const homePickErrorTimerRef = useRef<number | null>(null);
  const localPickInputRef = useRef<HTMLInputElement | null>(null);
  const localPickKindRef = useRef<HomeCardPickKind>("files");

  const showHomePickError = useCallback((message: string) => {
    setHomePickError(message);
    if (homePickErrorTimerRef.current != null) window.clearTimeout(homePickErrorTimerRef.current);
    homePickErrorTimerRef.current = window.setTimeout(() => setHomePickError(null), 6000);
  }, []);

  // 纯浏览器模式兑底：无本地路径桥（File 对象没有绝对路径），把选中文件
  // 上传为工作副本（数据目录是允许根），再打开副本。
  const openViaBrowserUpload = useCallback(async (picked: FileList | File[] | null) => {
    const file = picked && picked[0];
    if (!file) return;
    try {
      const form = new FormData();
      form.append("files", file);
      const res = await fetch("/api/uploads", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as {
        uploaded?: Array<{ name: string; path: string }>;
        error?: string;
      };
      const entry = data.uploaded?.[0];
      if (!res.ok || !entry?.path) throw new Error(data.error ?? `HTTP ${res.status}`);
      handleOpenFile(entry.path, entry.name || getFileName(entry.path));
    } catch (error) {
      showHomePickError(translate("rightPanel.pickFailed", { message: error instanceof Error ? error.message : String(error) }));
    }
  }, [handleOpenFile, showHomePickError, translate]);

  /** 任务区「文件」「表格」卡片：让用户挑选本地文件直接在右侧面板打开。 */
  // 纯浏览器模式/主进程旧版兑底：退化为隐藏 <input type=file>，选择后上传副本再打开
  const startBrowserPick = useCallback((kind: HomeCardPickKind) => {
    localPickKindRef.current = kind;
    const input = localPickInputRef.current;
    if (!input) return;
    input.accept = kind === "sheets" ? ".xlsx,.xlsm,.xls,.csv,.tsv,.univer" : "";
    input.value = "";
    input.click();
  }, []);

  /** 任务区「文件」「表格」卡片：让用户挑选本地文件直接在右侧面板打开。 */
  const pickLocalAndOpen = useCallback((kind: HomeCardPickKind) => {
    const nativePick = getNativePickApi();
    if (nativePick) {
      void (async () => {
        let picked: { canceled: boolean; filePath: string | null; error?: string };
        try {
          picked = await nativePick({
            title: translate(kind === "sheets" ? "rightPanel.pickSheetTitle" : "rightPanel.pickFileTitle"),
            ...(kind === "sheets"
              ? { filters: [
                  { name: translate("rightPanel.pickSheetFilterName"), extensions: ["xlsx", "xlsm", "xls", "csv", "tsv", "univer"] },
                  { name: translate("rightPanel.pickAllFiles"), extensions: ["*"] },
                ] }
              : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // 版本错配（改了 preload 后未重启 Electron 主进程，或旧打包壳）：
          // 新 preload 暴露了 pickOpenFile 但旧 main 没注册 handler。静默退到
          // 浏览器兑底路径而不是报错，功能依旧可用。
          if (/No handler registered/i.test(message)) {
            startBrowserPick(kind);
            return;
          }
          showHomePickError(translate("rightPanel.pickFailed", { message }));
          return;
        }
        if (picked && picked.error && !picked.canceled && !picked.filePath) {
          showHomePickError(translate("rightPanel.pickFailed", { message: picked.error }));
          return;
        }
        if (!picked || picked.canceled || !picked.filePath) return;
        try {
          // 把用户选中的文件目录加入本次进程可读根，/api/files 才能伺服原文件
          const res = await fetch("/api/files/allow-local", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: picked.filePath }),
          });
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
        } catch (error) {
          showHomePickError(translate("rightPanel.pickFailed", { message: error instanceof Error ? error.message : String(error) }));
          return;
        }
        handleOpenFile(picked.filePath, getFileName(picked.filePath));
      })();
      return;
    }
    startBrowserPick(kind);
  }, [handleOpenFile, showHomePickError, startBrowserPick, translate]);

  // ---- Web tabs (right-panel browser, Codex-style page preview) ----

  const webTabSeqRef = useRef(0);
  const lastBrowserMarkerIdRef = useRef<string | null>(null);

  /**
   * Open (or focus) a web tab in the right panel. url === null always creates
   * a fresh empty browser tab with a focused address bar.
   */
  const openWebTab = useCallback((url: string | null, title?: string | null) => {
    if (url) {
      const existing = fileTabs.find((t) => t.kind === "web" && t.url === url);
      if (existing) {
        setActiveFileTabId(existing.id);
        setRightPanelMode("files");
        setRightPanelOpen(true);
        if (isMobile) setSidebarOpen(false);
        return;
      }
    }
    const label = url ? (title ?? getHostname(url)) : translate("browser.newTab");
    const id = `web:${++webTabSeqRef.current}`;
    setFileTabs((prev) => [...prev, { id, label, kind: "web", url: url ?? null }]);
    setActiveFileTabId(id);
    setRightPanelMode("files");
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [fileTabs, isMobile, translate]);

  // 对话里的外部 http(s) 链接：在右侧面板打开网页标签（而不是新浏览器标签）。
  const handleOpenWebUrl = useCallback((url: string) => {
    openWebTab(url);
  }, [openWebTab]);

  /** Open the terminal as a normal tab inside the unified file bar. */
  const openTerminalTab = useCallback(() => {
    setTerminalOpen(true);
    setActiveFileTabId(TERMINAL_TAB_ID);
    setRightPanelMode("files");
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  /** User navigated inside a web tab — refresh its label, drop any pending agent marker. */
  const handleWebNavigate = useCallback((tabId: string, url: string | null) => {
    setFileTabs((prev) => prev.map((t) => {
      if (t.id !== tabId || !url) return t;
      const next: Tab = { ...t };
      next.label = getHostname(url);
      return next;
    }));
    // A stale marker would re-open the page the agent asked for; the user is
    // now in control of the panel, so clear any pending intent.
    void fetch("/api/browser", { method: "DELETE" }).catch(() => {});
  }, []);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  showChatRef.current = showChat;
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  // Poll the agent-facing browser marker (/api/browser). When a new marker
  // appears, open the URL in the right panel (agent-driven preview — the agent
  // POSTs it via curl, e.g. to show a dev server it just started), then clear
  // the marker so it only applies once. Runs continuously: the read is a tiny
  // local JSON file, and it lets the CLI agent push pages even when no session
  // is selected yet.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch("/api/browser");
        const data = (await response.json()) as {
          id?: string | null;
          url?: string | null;
          title?: string | null;
        };
        if (cancelled || !data.id || !data.url) return;
        if (data.id === lastBrowserMarkerIdRef.current) return;
        lastBrowserMarkerIdRef.current = data.id;
        openWebTab(data.url, data.title ?? null);
        void fetch("/api/browser", { method: "DELETE" }).catch(() => {});
      } catch {
        /* transient — next poll retries */
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [openWebTab]);

  // Poll the agent-facing open-file-request marker (/api/open-file-request).
  // When a new marker appears, open that file in the right panel (the agent
  // pushes a file it just generated, e.g. a spreadsheet it wrote via univer),
  // then clear the marker so it only applies once.
  const lastOpenFileRequestIdRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch("/api/open-file-request");
        const data = (await response.json()) as {
          id?: string | null;
          filePath?: string | null;
          title?: string | null;
        };
        if (cancelled || !data.id || !data.filePath) return;
        if (data.id === lastOpenFileRequestIdRef.current) return;
        lastOpenFileRequestIdRef.current = data.id;
        const filePath = data.filePath;
        const markerId = data.id; // 收窄后提为常量：闭包里 TS 不保留属性收窄
        const openWith = (homeMode?: "files" | "sheets") =>
          handleOpenFile(filePath, data.title ?? getFileName(filePath), {
            sourceSessionId: selectedSession?.id ?? null,
            ...(homeMode ? { homeMode } : {}),
          });
        const lower = filePath.toLowerCase();
        // 清 marker 用 compare-and-delete（带 id）：只清自己消费掉的那条——窗口期内
        // agent 连续推送的新 marker（新 id）不被误删，下一轮 poll 正常打开。
        // .univer 分支还需等 units 探测（2-3s）完成后才清，避免探测期间新 marker 被吞。
        const clearMarker = () => {
          void fetch(`/api/open-file-request?id=${encodeURIComponent(markerId)}`, { method: "DELETE" }).catch(() => {});
        };
        if (lower.endsWith(".univer")) {
          // Slide/doc decks belong under Files; sheet workbooks under
          // Spreadsheets — ask the backend for the unit kinds so agent-pushed
          // files land in the right tab bar (user report 2026-08-28: a PPT
          // landed under the Spreadsheets tab). ~2-3s roundtrip, worth it.
          fetch(`/api/univer/units?file=${encodeURIComponent(filePath)}`)
            .then((r) => r.json() as Promise<{ units?: Array<{ kind: string }> }>)
            .then((d) => {
              const hasSheet = Array.isArray(d.units) && d.units.some((u) => u.kind === "sheet");
              openWith(hasSheet ? "sheets" : "files");
            })
            .catch(() => openWith())
            .finally(clearMarker);
        } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv")) {
          openWith("sheets");
          clearMarker();
        } else {
          openWith("files");
          clearMarker();
        }
      } catch {
        /* transient — next poll retries */
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [handleOpenFile, selectedSession?.id]);

  const activeTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;

  // Report the right-panel active file to pi-studio's open-file marker
  // (default <project>/pi-web-uploads/.internal/pi-web-open-file.json, see /api/open-file) so the agent can default to the file currently open
  // when the user asks to edit "my table". Only POST when the path changes;
  // the sentinel initial value forces one sync on mount so hot reloads / page
  // loads re-report (or clear) the currently open file.
  const lastReportedFilePath = useRef<string | null>("__init__");
  useEffect(() => {
    // Only file tabs are reported — web tabs carry no file path.
    const filePath = activeTab?.kind === "file" ? (activeTab.filePath ?? null) : null;
    if (filePath === lastReportedFilePath.current) return;
    lastReportedFilePath.current = filePath;
    void fetch("/api/open-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath }),
    }).catch(() => {});
  }, [activeTab?.kind, activeTab?.filePath]);

  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - Pi Studio` : "Pi Studio";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const secondColumnCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null;

  const sidebarContent = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ display: activeActivity === "sessions" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onCreateTeam={(cwd) => {
          // 直接创建项目组（不弹窗）：POST /api/teams，默认仅组长
          void fetch("/api/teams", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd }),
          })
            .then((r) => (r.ok ? r.json() : Promise.reject(r)))
            .then((data) => {
              setRefreshKey((k) => k + 1);
              return fetch(`/api/sessions/${encodeURIComponent(data.sessionId)}`);
            })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
              if (d?.info) handleSelectSession(d.info as SessionInfo);
            })
            .catch(() => setRefreshKey((k) => k + 1));
        }}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onRunningSessionsChange={setRunningSessionIds}
        onUnreadSessionsChange={setUnreadSessionCount}
      />
      </div>
      {activeActivity === "files" && (
        <FileBrowserPanel
          cwd={secondColumnCwd}
          onOpenFile={handleOpenFile}
          onAtMention={handleAtMention}
          onAtMentions={handleAtMentions}
          explorerRefreshKey={explorerRefreshKey}
          onExplorerRefresh={handleExplorerRefresh}
        />
      )}
      {activeActivity === "skills" && <SkillsPanel cwd={secondColumnCwd} />}
      {activeActivity === "settings" && (
        <SettingsPanel
          cwd={secondColumnCwd}
          hasSession={selectedSession !== null}
          systemPrompt={systemPrompt}
          branchTree={branchTree}
          branchActiveLeafId={branchActiveLeafId}
          onBranchLeafChange={handleBranchLeafChange}
          onOpenModels={() => setModelsConfigOpen(true)}
          onOpenSkills={() => setSkillsConfigOpen(true)}
          onOpenPlugins={() => setPluginsConfigOpen(true)}
          onOpenUploads={() => setUploadsManagerOpen(true)}
          onViewHistory={handleViewFullHistory}
          onAutoName={() => { void handleAutoName(); }}
        />
      )}
    </div>
  );

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(78,173,104,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
    `}</style>
    <div style={{
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "var(--app-viewport-height, 100dvh)",
      paddingLeft: "env(safe-area-inset-left)",
      paddingRight: "env(safe-area-inset-right)",
      overflow: "hidden",
      background: "var(--bg)",
    }}>
        {/* 动态背景层：DeepSeek Harness 官网风格（固定最底层、不遮挡交互） */}
        <GlowBackground />
        {/* Top bar: window drag region + file panel toggle + window controls */}
        <div ref={topBarRef} style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--hairline)", height: "calc(36px + env(safe-area-inset-top))", paddingTop: "env(safe-area-inset-top)", background: "var(--bg-panel)", position: "relative" }}>
          {/* App brand: mark + name in the window title bar (top-most row) */}
          <div
            className="app-region-drag"
            style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 8, height: "100%", flexShrink: 0, userSelect: "none" }}
          >
            <button
              type="button"
              className="app-region-no-drag"
              onClick={() => setActiveActivity("sessions")}
              aria-label="Pi Studio"
              title="Pi Studio"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 4h7a5 5 0 0 1 5 5v11h-7a5 5 0 0 1-5-5V4z" fill="var(--accent)" stroke="none" />
                <path d="M13 4h7v7a5 5 0 0 1-5 5h-2" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </button>
            <span style={{ fontSize: 13, fontWeight: 650, letterSpacing: "-0.01em", color: "var(--text)", whiteSpace: "nowrap" }}>Pi Studio</span>
          </div>
          {/* Drag region — grab the window here (buttons below stay clickable) */}
          <div
            className="app-region-drag"
            aria-hidden="true"
            style={{ flex: 1, minWidth: 0, height: "100%", alignSelf: "stretch" }}
          />
          {/* Content controls (session search + full-width + trust) — merged into the top bar */}
          {showChat && (
            <>
              {projectTrust?.requiresTrust && !projectTrust.trusted && (
                <button
                  onClick={() => {
                    setProjectTrustError(null);
                    setProjectTrustDialogOpen(true);
                  }}
                  title={translate("trust.resourcesNotLoaded")}
                  aria-label={translate("trust.resourcesNotLoaded")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 36, height: "100%", padding: 0, flexShrink: 0,
                    background: "none", border: "none", borderLeft: "1px solid var(--hairline)",
                    color: "#d97706", cursor: "pointer", transition: "color 0.12s, background 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "#b45309"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "#d97706"; e.currentTarget.style.background = "none"; }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="M12 8v4" /><path d="M12 16h.01" />
                  </svg>
                </button>
              )}
              <button
                ref={contentSearchBtnRef}
                onClick={() => { setContentSearchOpen((v) => !v); setContentSearchQuery(""); }}
                title={`${translate("chat.searchContent")} (Ctrl+Shift+F)`}
                aria-label={translate("chat.searchContent")}
                aria-pressed={contentSearchOpen}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 36, height: "100%", padding: 0, flexShrink: 0,
                  background: contentSearchOpen ? "var(--bg-selected)" : "none",
                  border: "none",
                  color: contentSearchOpen ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer", transition: "color 0.12s, background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = contentSearchOpen ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
              <button
                onClick={() => setChatFullWidth((v) => !v)}
                title={translate("chat.fullWidth")}
                aria-label={translate("chat.fullWidth")}
                aria-pressed={chatFullWidth}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 36, height: "100%", padding: 0, flexShrink: 0,
                  background: chatFullWidth ? "var(--bg-selected)" : "none",
                  border: "none",
                  color: chatFullWidth ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer", transition: "color 0.12s, background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = chatFullWidth ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="18 8 22 12 18 16" /><polyline points="6 8 2 12 6 16" /><line x1="2" y1="12" x2="22" y2="12" />
                </svg>
              </button>
            </>
          )}
          {/* Right panel toggle — in the top bar, left of the window controls */}
          <button
            onClick={toggleRightPanel}
            aria-controls="file-panel"
            aria-expanded={rightPanelOpen}
            aria-pressed={rightPanelOpen}
            title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
            aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: "100%", padding: 0, flexShrink: 0,
              background: rightPanelOpen ? "var(--bg-selected)" : "none",
              border: "none",
              color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
          {/* Window controls (Electron only) — minimize / maximize / close */}
          <WindowControls />
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div ref={topPanelRef} style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: `calc(100dvh - ${topPanelPos.top}px)`,
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--hairline)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                    ];
                    const messageRows = [
                       [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                       [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                       [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                       [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                       [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                       [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                       [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                       ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                       ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                       [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                           title={copied ? translate("session.copied") : translate(field === "file" ? "session.copyFile" : "session.copyId")}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                         <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: 12,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        {sessionInfoSection}
                         {section(translate("session.messages"), messageRows)}
                         {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Content row (below the full-width top bar) */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }}>
      {/* First-level activity bar (一级导航) — column 1 */}
      <ActivityBar
        active={activeActivity}
        onSelect={handleSelectActivity}
        onSearch={() => {
          setPaletteMode("all");
          setPaletteOpen(true);
        }}
        onToggleSidebar={handleSidebarToggle}
        sidebarOpen={sidebarOpen}
        hasRunningSession={runningSessionIds.size > 0}
        hasUnreadSessions={unreadSessionCount > 0}
      />

      {/* Left sidebar (second column) */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
          /* 玻璃工作区：与 Composer/用户气泡同配方的 iMessage 玻璃水滴材质——
             半透明底 + 顶部淡 accent 斜向染 + backdrop 模糊，让动态背景从侧栏透出。
             用内联样式写在 globals.css 之外，避开打包时 lightningcss 折叠 -webkit- 前缀的坑。 */
          background:
            "linear-gradient(168deg, color-mix(in srgb, var(--accent) 7%, transparent) 0%, color-mix(in srgb, var(--accent) 2%, transparent) 36%, transparent 64%), color-mix(in srgb, var(--bg-panel) 60%, transparent)",
          backdropFilter: "blur(26px) saturate(1.45)",
          WebkitBackdropFilter: "blur(26px) saturate(1.45)",
          borderRight: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          zIndex: 200,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {sidebarOpen && (
        <div
          {...sidebarResizer.separatorProps}
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Chat header — session info + search + stats, above the chat content （项目组视图下合并进 TeamChat 头部，仅保留 1 行） */}

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {showChat ? (
            <ChatWorkspace
              session={selectedSession}
              newSessionCwd={effectiveNewSessionCwd}
              sessionKey={sessionKey}
              chatInputRef={chatInputRef}
              fullWidth={chatFullWidth}
              modelsRefreshKey={modelsRefreshKey}
              runningSessionIds={runningSessionIds}
              onAgentEnd={handleAgentEnd}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              onOpenFile={handleOpenLinkedFile}
              onOpenWebUrl={handleOpenWebUrl}
              onOpenChangedFile={handleOpenChangedFile}
              onSessionStatsPanelOpen={openSessionStatsPanel}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSessionStatsChange={handleSessionStatsChange}
              onContextUsageChange={handleContextUsageChange}
              onSelectSession={handleSelectSession}
              jumpTarget={jumpTarget}
              aiEditContext={aiEditContext}
              onAiEditContextConsumed={() => setAiEditContext(null)}
            />
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "#dc2626" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                 {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                   <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
      </div>
        </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}
        onClick={() => setRightPanelOpen(false)}
      />
      {rightPanelOpen && !rightPanelMaximized && (
        <div
          {...rightPanelResizer.separatorProps}
          aria-controls="file-panel"
          className={`panel-resize-handle right-panel-resize-handle${rightPanelResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="right-panel"
          title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        ref={rightPanelResizer.panelRef}
        id="file-panel"
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}${rightPanelMaximized ? " right-panel-maximized" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          position: "relative",
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--hairline)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        {/* Right panel header: home toggle + panel controls (mode pills removed —
            page switching is unified through the home task cards) */}
        <div style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "calc(36px + env(safe-area-inset-top))",
          paddingTop: "env(safe-area-inset-top)",
          paddingLeft: 10,
          paddingRight: 6,
          gap: 2,
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--hairline)",
        }}>
          {/* Home (Codex-style task cards) */}
          <button
            type="button"
            onClick={() => {
              // Toggle: the grid icon opens the task-card home; clicking it
              // again returns to the unified file bar so already-open tabs
              // stay reachable.
              if (rightPanelMode === "home") {
                setRightPanelMode(lastNonHomeModeRef.current);
              } else {
                setRightPanelMode("home");
              }
            }}
            title={translate(rightPanelMode === "home" ? "rightPanel.backToTabs" : "rightPanel.home")}
            aria-label={translate(rightPanelMode === "home" ? "rightPanel.backToTabs" : "rightPanel.home")}
            aria-pressed={rightPanelMode === "home"}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              marginRight: 4,
              background: rightPanelMode === "home" ? "var(--accent-soft)" : "none",
              border: "none",
              borderRadius: 7,
              color: rightPanelMode === "home" ? "var(--accent-hover)" : "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => {
              if (rightPanelMode !== "home") { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }
            }}
            onMouseLeave={(e) => {
              if (rightPanelMode !== "home") { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={rightPanelMode === "home" ? 2 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </button>

          {/* Spacer */}
          <div style={{ flex: 1, minWidth: 0 }} />

          {/* Maximize button */}
          {!isMobile && (
            <button
              type="button"
              onClick={handleToggleRightPanelMaximize}
              title={rightPanelMaximized ? translate("files.restorePanel") : translate("files.maximizePanel")}
              aria-label={rightPanelMaximized ? translate("files.restorePanel") : translate("files.maximizePanel")}
              aria-pressed={rightPanelMaximized}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28, padding: 0,
                background: rightPanelMaximized ? "var(--bg-selected)" : "none",
                border: "none",
                borderRadius: 6,
                color: rightPanelMaximized ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer", flexShrink: 0,
                transition: "color 0.12s, background 0.12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelMaximized ? "var(--text)" : "var(--text-muted)"; }}
            >
              {rightPanelMaximized ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                  <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              )}
            </button>
          )}

          {/* Close right panel */}
          <button
            type="button"
            onClick={() => setRightPanelOpen(false)}
            title={translate("i18n.close")}
            aria-label={translate("i18n.close")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 28, height: 28, padding: 0,
              background: "none", border: "none",
              borderRadius: 6,
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Right-panel content: mode-switched */}
        <div style={{ flex: 1, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {/* Home: Codex-style task cards */}
          {rightPanelMode === "home" && (() => {
            const CARD_ICONS: Record<string, React.ReactNode> = {
              files: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>,
              sheets: <><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /></>,
              browser: <><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></>,
              terminal: <><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>,
            };
            const cards: Array<{ key: "files" | "sheets" | "browser" | "terminal"; color: string; desc: string; onClick: () => void }> = [
              { key: "files", color: "#2a7aff", desc: translate("rightPanel.cardFilesDesc"), onClick: () => pickLocalAndOpen("files") },
              { key: "sheets", color: "#14b8a6", desc: translate("rightPanel.cardSheetsDesc"), onClick: () => pickLocalAndOpen("sheets") },
              { key: "browser", color: "#7c5cff", desc: translate("rightPanel.cardBrowserDesc"), onClick: () => openWebTab(null) },
              { key: "terminal", color: "#64748b", desc: translate("rightPanel.cardTerminalDesc"), onClick: openTerminalTab },
            ];
            return (
              <div style={{ height: "100%", overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px 18px" }}>
                <div style={{ width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>{translate("rightPanel.homeTitle")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: homePickError ? 6 : 18 }}>{translate("rightPanel.homeSubtitle")}</div>
                  {homePickError && (
                    <div
                      role="alert"
                      style={{
                        width: "100%",
                        padding: "7px 11px",
                        marginBottom: 12,
                        background: "color-mix(in srgb, #ef4444 10%, transparent)",
                        border: "1px solid color-mix(in srgb, #ef4444 35%, transparent)",
                        borderRadius: 9,
                        fontSize: 11.5,
                        lineHeight: 1.5,
                        color: "#ef4444",
                        wordBreak: "break-word",
                      }}
                    >
                      {homePickError}
                    </div>
                  )}
                  <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
                    {cards.map((card) => (
                      <button
                        key={card.key}
                        type="button"
                        onClick={card.onClick}
                        title={translate(`rightPanel.${card.key}`)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 14,
                          width: "100%",
                          padding: "16px 18px",
                          background: "var(--bg-panel)",
                          border: "1px solid var(--hairline)",
                          borderRadius: 14,
                          cursor: "pointer",
                          textAlign: "left",
                          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                          transition: "transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.transform = "translateY(-1px)";
                          e.currentTarget.style.boxShadow = "0 4px 14px rgba(0,0,0,0.08)";
                          e.currentTarget.style.borderColor = card.color;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.transform = "none";
                          e.currentTarget.style.boxShadow = "0 1px 2px rgba(0,0,0,0.04)";
                          e.currentTarget.style.borderColor = "var(--hairline)";
                        }}
                      >
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 40,
                            height: 40,
                            borderRadius: 12,
                            background: `color-mix(in srgb, ${card.color} 12%, transparent)`,
                            color: card.color,
                            flexShrink: 0,
                          }}
                        >
                          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            {CARD_ICONS[card.key]}
                          </svg>
                        </span>
                        <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{translate(`rightPanel.${card.key}`)}</span>
                          <span style={{ fontSize: 11.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.desc}</span>
                        </span>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}
          {/* Unified file bar: every open content tab lives here — files,
              spreadsheets, browser pages and the terminal all sit side-by-side
              in ONE tab bar, so opening anything never hides what was already
              open (single bar + single keep-alive stack). */}
          {rightPanelMode === "files" && (() => {
            const terminalTab = terminalOpen ? {
              id: TERMINAL_TAB_ID,
              label: translate("rightPanel.terminal"),
              kind: "terminal" as const,
            } : null;
            const allTabs = terminalTab ? [...fileTabs, terminalTab] : fileTabs;
            const activeId = allTabs.some((t) => t.id === activeFileTabId)
              ? activeFileTabId
              : allTabs[allTabs.length - 1]?.id ?? null;
            return (
              <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
                {allTabs.length > 0 && (
                  <div style={{
                    display: "flex", alignItems: "center",
                    height: 34, flexShrink: 0,
                    background: "var(--bg-panel)",
                    borderBottom: "1px solid var(--hairline)",
                  }}>
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <TabBar
                        tabs={allTabs}
                        activeTabId={activeId ?? ""}
                        onSelectTab={setActiveFileTabId}
                        onCloseTab={handleCloseFileTab}
                      />
                    </div>
                  </div>
                )}
                {/* Keep-alive stack, applied uniformly: inactive content stays
                    mounted and hidden via visibility so viewers, WebContentsView
                    and gateway iframes keep their state instead of reloading. */}
                <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
                  {allTabs.map((tab) => {
                    const isActive = tab.id === activeId;
                    if (tab.kind === "terminal") {
                      return (
                        <div
                          key={tab.id}
                          style={{
                            position: "absolute", inset: 0,
                            visibility: isActive ? "inherit" : "hidden",
                            zIndex: isActive ? 1 : 0,
                            pointerEvents: isActive ? "auto" : "none",
                          }}
                        >
                          <TerminalPanel cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null} />
                        </div>
                      );
                    }
                    if (tab.kind === "web") {
                      return (
                        <div
                          key={tab.id}
                          style={{
                            position: "absolute", inset: 0,
                            visibility: isActive ? "inherit" : "hidden",
                            zIndex: isActive ? 1 : 0,
                            pointerEvents: isActive ? "auto" : "none",
                          }}
                        >
                          <WebViewer
                            tabId={tab.id}
                            initialUrl={tab.url ?? null}
                            active={isActive}
                            sessionEpoch={sessionKey}
                            onNavigate={(url) => handleWebNavigate(tab.id, url)}
                          />
                        </div>
                      );
                    }
                    if (!tab.filePath) return null;
                    return (
                      <div
                        key={tab.id}
                        style={{
                          position: "absolute", inset: 0,
                          visibility: isActive ? "inherit" : "hidden",
                          zIndex: isActive ? 1 : 0,
                          pointerEvents: isActive ? "auto" : "none",
                        }}
                      >
                        <FileViewer
                          filePath={tab.filePath}
                          cwd={activeCwd ?? undefined}
                          sourceSessionId={tab.sourceSessionId}
                          gitRefreshKey={explorerRefreshKey}
                          initialDisplayMode={tab.initialDisplayMode}
                          onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
                          onOpenFile={(filePath) => handleOpenFile(
                            filePath,
                            getFileName(filePath),
                            { sourceSessionId: tab.sourceSessionId },
                          )}
                          onAiEdit={handleAiEdit}
                        />
                      </div>
                    );
                  })}
                </div>
                {allTabs.length === 0 && (
                  <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12, flexDirection: "column", gap: 8 }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span>{translate("files.noneOpen")}</span>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>
      </div>
    </div>
    {/* Content search dropdown */}
    {contentSearchOpen && contentSearchPos && (
      <div
        style={{
          position: "fixed",
          top: contentSearchPos.top,
          right: contentSearchPos.right,
          width: 360,
          maxWidth: "calc(100vw - 24px)",
          zIndex: 500,
          background: "var(--bg-panel)",
          border: "1px solid var(--hairline)",
          borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.10)",
          padding: 6,
        }}
      >
        <input
          ref={searchInputRef}
          autoFocus
          value={contentSearchQuery}
          onChange={(e) => setContentSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setContentSearchOpen(false); setContentSearchQuery(""); return; }
            if (contentSearchResults.length === 0) return;
            if (e.key === "Enter") {
              e.preventDefault();
              const dir = e.shiftKey ? -1 : 1;
              const base = contentSearchActiveIdx >= 0 ? contentSearchActiveIdx : (e.shiftKey ? 0 : -1);
              const next = (base + dir + contentSearchResults.length) % contentSearchResults.length;
              const r = contentSearchResults[next];
              if (r?.entryId) setJumpTarget({ entryId: r.entryId, nonce: Date.now() });
              setContentSearchActiveIdx(next);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const dir = e.key === "ArrowDown" ? 1 : -1;
              const base = contentSearchActiveIdx >= 0 ? contentSearchActiveIdx : (dir === 1 ? -1 : 0);
              setContentSearchActiveIdx((base + dir + contentSearchResults.length) % contentSearchResults.length);
            }
          }}
          placeholder={translate("chat.searchPlaceholder")}
          style={{
            width: "100%", boxSizing: "border-box",
            fontSize: 13, fontFamily: "inherit",
            padding: "7px 10px",
            border: "1px solid var(--border)", borderRadius: 6,
            outline: "none", background: "var(--bg)", color: "var(--text)",
          }}
        />
        <div style={{ padding: "5px 4px 1px", fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
          {translate("chat.searchNavHint")}
        </div>
        <div ref={contentSearchResultsRef} style={{ maxHeight: "min(50vh, 420px)", overflowY: "auto", marginTop: 6 }}>
          {contentSearchLoading ? (
            <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>{translate("sidebar.loading")}</div>
          ) : contentSearchResults.length === 0 && contentSearchQuery.trim() ? (
            <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>{translate("chat.searchNoResults")}</div>
          ) : (
            contentSearchResults.map((r, i) => (
              <button
                key={r.entryId}
                type="button"
                data-search-idx={i}
                onClick={() => {
                  if (r.entryId) setJumpTarget({ entryId: r.entryId, nonce: Date.now() });
                  setContentSearchActiveIdx(-1);
                  setContentSearchOpen(false);
                  setContentSearchQuery("");
                }}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                  width: "100%", padding: "7px 10px",
                  background: contentSearchActiveIdx === i ? "var(--bg-selected)" : "transparent",
                  border: "none", borderRadius: 6,
                  color: "var(--text)", cursor: "pointer", textAlign: "left",
                }}
                onMouseEnter={() => setContentSearchActiveIdx(i)}
                onMouseLeave={() => setContentSearchActiveIdx(-1)}
              >
                <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 600, letterSpacing: "0.02em" }}>
                  {r.role === "user" ? translate("session.user") : r.role === "assistant" ? translate("session.assistant") : r.role}
                </span>
                <span style={{ fontSize: 12, lineHeight: 1.45, color: "var(--text)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>
                  {excerpt(r.text, contentSearchQuery)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    )}

    {modelsConfigOpen && <ModelsConfig onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} />}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    {skillsConfigOpen && projectTrustCwd && (
      <SkillsConfig cwd={projectTrustCwd} onClose={() => setSkillsConfigOpen(false)} />
    )}
    {pluginsConfigOpen && projectTrustCwd && (
      <PluginsConfig
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        onClose={() => setPluginsConfigOpen(false)}
        onReloaded={() => setSessionKey((k) => k + 1)}
      />
    )}
    {uploadsManagerOpen && (
      <UploadsManager
        onClose={() => setUploadsManagerOpen(false)}
        onOpenFile={(path, name) => handleOpenFile(path, name)}
      />
    )}
    {/* 任务区「文件/表格」卡片的纯浏览器兑底：无 Electron 桥时用隐藏 input 选本地
        文件上传为工作副本再打开（渲染层拿不到绝对路径）。*/}
    <input
      ref={localPickInputRef}
      type="file"
      tabIndex={-1}
      aria-hidden="true"
      style={{ display: "none" }}
      onChange={(event) => {
        const files = event.target.files;
        event.target.value = "";
        void openViaBrowserUpload(files);
      }}
    />
    <CommandPalette
      open={paletteOpen}
      mode={paletteMode}
      cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null}
      onClose={() => setPaletteOpen(false)}
      onOpenFile={(path, name) => handleOpenFile(path, name)}
      onSelectSession={handleSelectSession}
      onSelectContentMatch={handleSelectContentMatch}
      onNewSession={() => {
        if (activeCwd) handleNewSession(`kb-${Date.now()}`, activeCwd);
      }}
      onSelectActivity={handleSelectActivity}
      onToggleTheme={() => toggleTheme()}
      onOpenModels={() => setModelsConfigOpen(true)}
      onOpenSkills={() => setSkillsConfigOpen(true)}
      onOpenPlugins={() => setPluginsConfigOpen(true)}
      onOpenUploads={() => setUploadsManagerOpen(true)}
    />
    </>
  );
}
