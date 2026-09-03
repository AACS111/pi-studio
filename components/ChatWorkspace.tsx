"use client";

import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { SessionInfo, SessionTreeNode } from "@/lib/types";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { useI18n } from "@/hooks/useI18n";
import { ChatWindow } from "./ChatWindow";
import type { ChatInputHandle } from "./ChatInput";
import { TeamChat } from "./TeamChat";

/* ------------------------------------------------------------------ */
/* Layout model: a binary split tree of chat panes.                    */
/* ------------------------------------------------------------------ */

type Dir = "H" | "V";

type TabKey = string;

/** An IDEA-style editor group: one pane holds its own set of tabs. */
interface Pane {
  tabs: TabKey[];
  active: number;
}

type Layout =
  | { kind: "leaf"; id: string; pane: Pane }
  | { kind: "split"; id: string; dir: Dir; children: Layout[]; sizes: number[] };

/** A tab open in the workspace that is NOT the AppShell-focused session. */
interface OpenTab {
  key: string;
  session: SessionInfo;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Divider {
  id: string;
  orientation: "v" | "h";
  x: number;
  y: number;
  w: number;
  h: number;
  splitId: string;
  boundaryIndex: number;
  /** Length (px) of the split region along the resize axis. */
  regionPx: number;
}

interface DropZone {
  dir: Dir | "center";
}

/** Max number of panes (editor groups) the workspace can be split into. */
const MAX_PANES = 4;

/** Narrow outer band (fraction) that still triggers a split; everything else adds to the group. */
const EDGE_FRAC = 0.16;

function countLeaves(node: Layout): number {
  if (node.kind === "leaf") return 1;
  return node.children.reduce((a, c) => a + countLeaves(c), 0);
}

/**
 * Classify a drop point within a pane: the ~top 36px (its tab bar) and the
 * broad center mean "add/move this tab into this group"; only a narrow outer
 * band on the remaining edges means "split a new pane off here".
 */
function computeDropZone(rect: Rect, clientX: number, clientY: number): DropZone {
  const relX = (clientX - rect.left) / (rect.width || 1);
  const relY = (clientY - rect.top) / (rect.height || 1);
  // The pane's tab bar occupies the top ~36px — dropping there adds to the group.
  const tabRatio = 36 / (rect.height || 1);
  if (relY <= tabRatio) return { dir: "center" };
  if (relX < EDGE_FRAC || relX > 1 - EDGE_FRAC) return { dir: "H" };
  if (relY < EDGE_FRAC || relY > 1 - EDGE_FRAC) return { dir: "V" };
  return { dir: "center" };
}

let idSeq = 0;
function nextId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${++idSeq}`;
}

function collectLeaves(node: Layout, out: Extract<Layout, { kind: "leaf" }>[] = []): Extract<Layout, { kind: "leaf" }>[] {
  if (node.kind === "leaf") {
    out.push(node);
    return out;
  }
  for (const child of node.children) collectLeaves(child, out);
  return out;
}

function computeLayout(
  node: Layout,
  size: { w: number; h: number },
  leaves: Map<string, Rect> = new Map(),
  dividers: Divider[] = [],
  rect: Rect = { left: 0, top: 0, width: size.w, height: size.h },
): { leaves: Map<string, Rect>; dividers: Divider[] } {
  if (node.kind === "leaf") {
    leaves.set(node.id, rect);
    return { leaves, dividers };
  }
  const total = node.sizes.reduce((a, b) => a + b, 0) || node.children.length;
  let offset = 0;
  for (let i = 0; i < node.children.length; i++) {
    const isHorizontal = node.dir === "H";
    const frac = (node.sizes[i] ?? 1) / total;
    const span = (isHorizontal ? rect.width : rect.height) * frac;
    const childRect: Rect = isHorizontal
      ? { ...rect, left: rect.left + offset, width: span }
      : { ...rect, top: rect.top + offset, height: span };
    computeLayout(node.children[i], size, leaves, dividers, childRect);
    offset += span;

    if (i < node.children.length - 1) {
      const regionPx = isHorizontal ? rect.width : rect.height;
      if (isHorizontal) {
        dividers.push({
          id: `${node.id}:${i}`,
          orientation: "v",
          x: rect.left + offset - 3,
          y: rect.top,
          w: 6,
          h: rect.height,
          splitId: node.id,
          boundaryIndex: i,
          regionPx,
        });
      } else {
        dividers.push({
          id: `${node.id}:${i}`,
          orientation: "h",
          x: rect.left,
          y: rect.top + offset - 3,
          w: rect.width,
          h: 6,
          splitId: node.id,
          boundaryIndex: i,
          regionPx,
        });
      }
    }
  }
  return { leaves, dividers };
}

function makePane(tabs: TabKey[], active = 0): Pane {
  return { tabs, active: tabs.length > 0 ? Math.min(active, tabs.length - 1) : 0 };
}

/** Replace leaf `leafId` by a split(dir, [leaf, newLeaf]) — new pane holds `newTabKey` alone. */
function splitAtLeaf(node: Layout, leafId: string, dir: Dir, newTabKey: TabKey): Layout {
  if (node.kind === "leaf") {
    if (node.id !== leafId) return node;
    return {
      kind: "split",
      id: nextId("s"),
      dir,
      children: [node, createSingleLeaf(newTabKey)],
      sizes: [1, 1],
    };
  }
  return { ...node, children: node.children.map((c) => splitAtLeaf(c, leafId, dir, newTabKey)) };
}

/** Remove `tabKey` from every pane, collapsing empty panes. Returns null if nothing remains. */
function detachTab(node: Layout, tabKey: TabKey): Layout | null {
  if (node.kind === "leaf") {
    if (!node.pane.tabs.includes(tabKey)) return node;
    const tabs = node.pane.tabs.filter((t) => t !== tabKey);
    if (tabs.length === 0) return null;
    return { ...node, pane: makePane(tabs, node.pane.active) };
  }
  const children = node.children
    .map((c) => detachTab(c, tabKey))
    .filter((c): c is Layout => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const sizes = children.map((_, i) => node.sizes[i] ?? 1);
  return { kind: "split", id: node.id, dir: node.dir, children, sizes };
}

function createSingleLeaf(tabKey: TabKey): Layout {
  return { kind: "leaf", id: nextId("l"), pane: makePane([tabKey]) };
}

/** The pane (leaf) that currently displays `tabKey`, if any. */
function leafForTab(node: Layout, tabKey: TabKey): Extract<Layout, { kind: "leaf" }> | null {
  if (node.kind === "leaf") return node.pane.tabs.includes(tabKey) ? node : null;
  for (const c of node.children) {
    const found = leafForTab(c, tabKey);
    if (found) return found;
  }
  return null;
}

/** First leaf in layout order — the fallback focus pane. */
function firstLeaf(node: Layout): Extract<Layout, { kind: "leaf" }> {
  if (node.kind === "leaf") return node;
  return firstLeaf(node.children[0]);
}

function activateTabIn(node: Layout, leafId: string, tabKey: TabKey): Layout {
  if (node.kind === "leaf") {
    const idx = node.pane.tabs.indexOf(tabKey);
    if (node.id !== leafId || idx === -1) return node;
    return { ...node, pane: makePane(node.pane.tabs, idx) };
  }
  return { ...node, children: node.children.map((c) => activateTabIn(c, leafId, tabKey)) };
}

function addTabToPane(node: Layout, leafId: string, tabKey: TabKey): Layout {
  if (node.kind === "leaf") {
    if (node.id !== leafId) return node;
    const tabs = node.pane.tabs.includes(tabKey) ? node.pane.tabs : [...node.pane.tabs, tabKey];
    return { ...node, pane: makePane(tabs, tabs.indexOf(tabKey)) };
  }
  return { ...node, children: node.children.map((c) => addTabToPane(c, leafId, tabKey)) };
}

/** Ensure `tabKey` appears and is active in some pane; append to the first pane if absent. */
function focusTabInLayout(node: Layout, tabKey: TabKey): Layout {
  const leaf = leafForTab(node, tabKey);
  if (leaf) return activateTabIn(node, leaf.id, tabKey);
  return addTabToPane(node, firstLeaf(node).id, tabKey);
}

/** 原位替换某窗格中的标签（如 primary 占位 ↔ new 草稿），保持其余标签与激活位置不变。
 *  目标窗格已含 `to` 时不做任何事。 */
function replaceTabInPane(node: Layout, leafId: string, from: TabKey, to: TabKey): Layout {
  if (node.kind === "leaf") {
    if (node.id !== leafId || node.pane.tabs.includes(to)) return node;
    const idx = node.pane.tabs.indexOf(from);
    if (idx === -1) return node;
    const tabs = node.pane.tabs.slice();
    tabs[idx] = to;
    return { ...node, pane: makePane(tabs, node.pane.active) };
  }
  return { ...node, children: node.children.map((c) => replaceTabInPane(c, leafId, from, to)) };
}

function adjustDividerSize(node: Layout, splitId: string, boundaryIndex: number, deltaFrac: number): Layout {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) {
    const sizes = node.sizes.slice();
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    const i = boundaryIndex;
    const j = i + 1;
    if (j >= sizes.length) return node;
    const minSize = 0.12 * total;
    const pair = sizes[i] + sizes[j];
    let newSi = sizes[i] + deltaFrac * total;
    newSi = Math.max(minSize, Math.min(pair - minSize, newSi));
    sizes[i] = newSi;
    sizes[j] = pair - newSi;
    return { ...node, sizes };
  }
  return { ...node, children: node.children.map((c) => adjustDividerSize(c, splitId, boundaryIndex, deltaFrac)) };
}

/* ------------------------------------------------------------------ */
/* Per-pane reported state.                                            */
/* ------------------------------------------------------------------ */

interface PaneReports {
  stats: SessionStatsInfo | null;
  context: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt: string | null;
  branch: { tree: SessionTreeNode[]; activeLeafId: string | null; onLeafChange: (leafId: string | null) => void } | null;
}

const EMPTY_REPORTS: PaneReports = { stats: null, context: null, systemPrompt: null, branch: null };

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

interface Props {
  /** AppShell-selected (focused) session — rendered as the primary tab. */
  session: SessionInfo | null;
  /** Cwd for a freshly-created (not yet saved) session. */
  newSessionCwd: string | null;
  /** AppShell-level remount key — bumped to force the primary pane to reload. */
  sessionKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  fullWidth?: boolean;
  modelsRefreshKey?: number;
  runningSessionIds?: Set<string>;
  jumpTarget?: { entryId: string; nonce: number } | null;
  aiEditContext?: { file: string; prompt: string } | null;
  onAiEditContextConsumed?: () => void;

  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenWebUrl?: (url: string) => void;
  onOpenChangedFile?: (filePath: string) => void;
  onSessionStatsPanelOpen?: () => void;

  // Report-up callbacks — forwarded only from the FOCUSED (primary) pane.
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;

  // Workspace lifecycle callbacks.
  onSelectSession?: (session: SessionInfo, isRestore?: boolean) => void;
}

function sessionTitle(session: SessionInfo | null, t: (k: string) => string): string {
  if (!session) return t("sidebar.selectSession");
  return (
    session.teamName ||
    session.name ||
    session.firstMessage.slice(0, 50) ||
    session.id.slice(0, 12)
  );
}

export function ChatWorkspace(props: Props) {
  const { t } = useI18n();
  const {
    session,
    newSessionCwd,
    sessionKey,
    chatInputRef,
    fullWidth,
    modelsRefreshKey,
    runningSessionIds,
    jumpTarget,
    aiEditContext,
    onAiEditContextConsumed,
    onAgentEnd,
    onSessionCreated,
    onSessionForked,
    onOpenFile,
    onOpenWebUrl,
    onOpenChangedFile,
    onSessionStatsPanelOpen,
    onBranchDataChange,
    onSystemPromptChange,
    onSessionStatsChange,
    onContextUsageChange,
    onSelectSession,
  } = props;

  const primaryTabKey = "primary";
  // The AppShell-focused session expressed as a tab key. This is the single
  // source of truth: the focused tab is always active in exactly one pane.
  const focusedTabKey = session ? `session:${session.id}` : newSessionCwd ? "new" : primaryTabKey;

  // Metadata store for every opened session except the AppShell-focused one.
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [layout, setLayout] = useState<Layout>(() => createSingleLeaf(focusedTabKey));

  const focusedSessionId = session?.id ?? null;
  useEffect(() => {
    if (!session || !session.id) return;
    setOpenTabs((prev) => {
      const key = `session:${session.id}`;
      const existing = prev.find((t) => t.key === key);
      return existing ? [{ ...existing, session }, ...prev.filter((t) => t.key !== key)] : [{ key, session }, ...prev];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedSessionId]);

  // Keep the focused tab active in some pane. Session tabs missing from the
  // layout (sidebar switch) are appended to the first pane. Draft keys (「new」/
  // primary) are only mounted on a focus TRANSITION (e.g. the initial navigation
  // resolving primary → new). After the user closes the draft, the focused key
  // stays stale on "new" — we deliberately do NOT auto-re-add it, so the pane
  // stays empty until the next 「新建会话」 click (its sessionKey bump re-creates
  // the draft in the sessionKey effect below).
  const prevFocusedRef = useRef<TabKey>(focusedTabKey);
  useEffect(() => {
    const prev = prevFocusedRef.current;
    prevFocusedRef.current = focusedTabKey;
    setLayout((cur) => {
      const leaf = leafForTab(cur, focusedTabKey);
      if (leaf) return activateTabIn(cur, leaf.id, focusedTabKey);
      if (focusedTabKey.startsWith("session:")) {
        return addTabToPane(cur, firstLeaf(cur).id, focusedTabKey);
      }
      if (prev !== focusedTabKey) {
        // 焦点转入草稿键：与原占位等价时原位替换（primary ↔ new），避免双草稿标签
        const first = firstLeaf(cur);
        const other = focusedTabKey === "new" ? primaryTabKey : "new";
        if (first.pane.tabs.includes(other)) {
          return replaceTabInPane(cur, first.id, other, focusedTabKey);
        }
        return addTabToPane(cur, first.id, focusedTabKey);
      }
      return cur;
    });
  }, [focusedTabKey]);

  // 外层显式动作（新建会话 / 切换项目 → sessionKey 递增）后，焦点停在草稿键但草稿
  // 标签已被用户关闭：重建草稿标签（primary 占位在则原位替换，否则追加到第一窗格）。
  // 用 useLayoutEffect：必须在 paint 前完成布局修正，否则 AppShell 里「新建会话」
  // 点击后的双 rAF 聚焦会先空跑（那时 ref 还没挂上）。
  useLayoutEffect(() => {
    if (session || focusedTabKey !== "new") return;
    setLayout((cur) => {
      if (leafForTab(cur, "new")) return cur;
      const first = firstLeaf(cur);
      if (first.pane.tabs.includes(primaryTabKey)) {
        return replaceTabInPane(cur, first.id, primaryTabKey, "new");
      }
      return addTabToPane(cur, first.id, "new");
    });
  }, [sessionKey, session, focusedTabKey]);

  /* ---------- report gating (only the focused pane forwards to AppShell) ---------- */

  const reportsRef = useRef<Map<string, PaneReports>>(new Map());
  const getReports = useCallback((tabKey: string): PaneReports => {
    let r = reportsRef.current.get(tabKey);
    if (!r) {
      r = { ...EMPTY_REPORTS };
      reportsRef.current.set(tabKey, r);
    }
    return r;
  }, []);

  const forwardReports = useCallback((tabKey: string) => {
    const r = getReports(tabKey);
    onSessionStatsChange?.(r.stats);
    onContextUsageChange?.(r.context);
    onSystemPromptChange?.(r.systemPrompt);
    if (r.branch) onBranchDataChange?.(r.branch.tree, r.branch.activeLeafId, r.branch.onLeafChange);
  }, [getReports, onSessionStatsChange, onContextUsageChange, onSystemPromptChange, onBranchDataChange]);

  // Re-forward focused state when the focused session changes.
  useEffect(() => {
    forwardReports(focusedTabKey);
  }, [focusedTabKey, forwardReports]);

  // Stable report handlers for the focused pane — recreating these every render
  // would re-trigger ChatWindow's useEffect deps and cause a setState loop.
  const handleFocusedBranch = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    getReports(focusedTabKey).branch = { tree, activeLeafId, onLeafChange };
    forwardReports(focusedTabKey);
  }, [getReports, forwardReports, focusedTabKey]);
  const handleFocusedSystemPrompt = useCallback((p: string | null) => {
    getReports(focusedTabKey).systemPrompt = p;
    forwardReports(focusedTabKey);
  }, [getReports, forwardReports, focusedTabKey]);
  const handleFocusedStats = useCallback((s: SessionStatsInfo | null) => {
    getReports(focusedTabKey).stats = s;
    forwardReports(focusedTabKey);
  }, [getReports, forwardReports, focusedTabKey]);
  const handleFocusedContext = useCallback((c: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    getReports(focusedTabKey).context = c;
    forwardReports(focusedTabKey);
  }, [getReports, forwardReports, focusedTabKey]);

  /* ---------- tab actions ---------- */

  /** Resolve a tab key to its session (focused session first, then openTabs). */
  const resolveSession = useCallback((tabKey: string): SessionInfo | null => {
    if (session && tabKey === `session:${session.id}`) return session;
    return openTabs.find((d) => d.key === tabKey)?.session ?? null;
  }, [session, openTabs]);

  /** Focus a tab: keep it active in its pane and make its session the AppShell one. */
  const focusTab = useCallback((tabKey: string) => {
    setLayout((cur) => focusTabInLayout(cur, tabKey));
    const s = resolveSession(tabKey);
    if (s) onSelectSession?.(s, false);
  }, [resolveSession, onSelectSession]);

  /** Add a session (dragged in from the sidebar) to openTabs; returns its tabKey. */
  const ensureOpenTab = useCallback((s: SessionInfo): string | null => {
    const key = `session:${s.id}`;
    setOpenTabs((prev) => (prev.some((d) => d.key === key) ? prev : [{ key, session: s }, ...prev]));
    return key;
  }, []);

  /** Close a tab — removes it from its pane (and openTabs), never deletes the session. */
  const closeTab = useCallback((tabKey: string) => {
    setOpenTabs((prev) => prev.filter((x) => x.key !== tabKey));
    let next: string | null = null;
    setLayout((cur) => {
      const after = detachTab(cur, tabKey);
      // Always keep at least one pane.
      if (!after) return createSingleLeaf(primaryTabKey);
      if (tabKey === focusedTabKey) {
        const leaf = firstLeaf(after);
        if (leaf && leaf.pane.tabs.length > 0) next = leaf.pane.tabs[Math.max(0, leaf.pane.active)];
      }
      return after;
    });
    if (next) {
      const s = resolveSession(next);
      if (s) onSelectSession?.(s, false);
    }
  }, [focusedTabKey, resolveSession, onSelectSession]);

  /* ---------- drag & drop ---------- */

  const [draggingTab, setDraggingTab] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ leafId: string; zone: DropZone } | null>(null);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; label: string } | null>(null);

  const tabLabelFor = useCallback((tabKey: string): string => {
    if (tabKey === primaryTabKey || tabKey === "new") return t("sidebar.newSession");
    const ot = openTabs.find((d) => d.key === tabKey);
    return ot ? sessionTitle(ot.session, t) : tabKey;
  }, [session, openTabs, t]);

  const handleTabDragStart = useCallback((e: React.DragEvent, tabKey: string) => {
    setDraggingTab(tabKey);
    e.dataTransfer.setData("text/pi-workspace-tab", tabKey);
    e.dataTransfer.effectAllowed = "move";
    setDragGhost({ x: e.clientX, y: e.clientY, label: tabLabelFor(tabKey) });
  }, [tabLabelFor]);

  const handleDrag = useCallback((e: React.DragEvent) => {
    if (draggingTab) setDragGhost({ x: e.clientX, y: e.clientY, label: tabLabelFor(draggingTab) });
  }, [draggingTab, tabLabelFor]);

  const handleDragEnd = useCallback(() => {
    setDraggingTab(null);
    setDropTarget(null);
    setDragGhost(null);
  }, []);

  const handleDropZoneEnter = useCallback((leafId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropTarget({ leafId, zone: computeDropZone(rect, e.clientX, e.clientY) });
  }, []);

  const handleDropZoneLeave = useCallback((e: React.DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
      setDropTarget(null);
    }
  }, []);

  const applyDrop = useCallback((targetLeafId: string, zone: DropZone, sourceTabKey: string) => {
    const dir = zone.dir;
    const resetDrag = () => { setDraggingTab(null); setDropTarget(null); setDragGhost(null); };
    if (dir === "center") {
      // Merge the dragged tab into the target pane (group accumulation) and focus it.
      setLayout((cur) => {
        const targetLeaf = collectLeaves(cur).find((l) => l.id === targetLeafId);
        if (!targetLeaf) return cur;
        if (targetLeaf.pane.tabs.includes(sourceTabKey)) return activateTabIn(cur, targetLeafId, sourceTabKey);
        const next = detachTab(cur, sourceTabKey);
        if (!next) return cur;
        if (!collectLeaves(next).some((l) => l.id === targetLeafId)) return cur;
        return addTabToPane(next, targetLeafId, sourceTabKey);
      });
      const ot = openTabs.find((d) => d.key === sourceTabKey);
      if (ot) focusTab(sourceTabKey);
      resetDrag();
      return;
    }
    // Split off a new pane showing the dragged tab (even if it already lives in
    // this pane, e.g. dragging a tab to its own pane's edge).
    setLayout((cur) => {
      if (countLeaves(cur) >= MAX_PANES) return cur;
      const targetLeaf = collectLeaves(cur).find((l) => l.id === targetLeafId);
      if (!targetLeaf) return cur;
      const next = detachTab(cur, sourceTabKey);
      if (!next) return cur; // source was the pane's only tab — would duplicate, so no-op
      if (!collectLeaves(next).some((l) => l.id === targetLeafId)) return cur;
      return splitAtLeaf(next, targetLeafId, dir, sourceTabKey);
    });
    resetDrag();
  }, [openTabs, focusTab]);

  const handleDrop = useCallback((targetLeafId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Compute center/edge from the real drop position (don't trust stored
    // dropTarget — it can be reset as the mouse passes children like the tab bar).
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const zone = computeDropZone(rect, e.clientX, e.clientY);
    const tabSource = e.dataTransfer.getData("text/pi-workspace-tab");
    if (tabSource) {
      applyDrop(targetLeafId, zone, tabSource);
      return;
    }
    // Session dragged in from the sidebar.
    const sessionJson = e.dataTransfer.getData("text/pi-session-drag");
    if (!sessionJson) return;
    try {
      const s = JSON.parse(sessionJson) as SessionInfo;
      const key = ensureOpenTab(s);
      if (!key) return;
      const dir = zone.dir;
      if (dir === "center") {
        // Drop into the pane's tab group (accumulate) and make it the focused session.
        setLayout((cur) => {
          const targetLeaf = collectLeaves(cur).find((l) => l.id === targetLeafId);
          if (!targetLeaf) return cur;
          if (targetLeaf.pane.tabs.includes(key)) return activateTabIn(cur, targetLeafId, key);
          return addTabToPane(cur, targetLeafId, key);
        });
        onSelectSession?.(s, false);
        setDraggingTab(null);
        setDropTarget(null);
        setDragGhost(null);
        return;
      }
      setLayout((cur) => {
        if (countLeaves(cur) >= MAX_PANES) return cur;
        const targetLeaf = collectLeaves(cur).find((l) => l.id === targetLeafId);
        if (!targetLeaf) return cur;
        const next = detachTab(cur, key);
        if (!next) return cur;
        if (!collectLeaves(next).some((l) => l.id === targetLeafId)) return cur;
        return splitAtLeaf(next, targetLeafId, dir, key);
      });
      setDraggingTab(null);
      setDropTarget(null);
      setDragGhost(null);
    } catch {
      /* ignore malformed payload */
    }
  }, [applyDrop, ensureOpenTab, onSelectSession]);

  /* ---------- divider resize ---------- */

  const handleDividerResize = useCallback((divider: Divider, deltaPx: number) => {
    const regionPx = divider.regionPx || 1;
    const deltaFrac = deltaPx / regionPx;
    setLayout((cur) => adjustDividerSize(cur, divider.splitId, divider.boundaryIndex, deltaFrac));
  }, []);

  /* ---------- render ---------- */

  /**
   * 新会话「转正」（草稿 → session:<id>）时复用草稿窗格的组件键。
   *
   * 默认键里带 sessionId，转正那一刻键会从 `new:<cwd>:<sk>` 变成 `focus:<sid>:<sk>`：
   * React 重挂载 ChatWindow → ① 正在流式的 SSE 会断掉重连（重连前的空档里，本轮的
   * agent_start / 用户消息事件直接丢失），② 又挂一层「正在加载会话…」骨架屏，③ 重
   * 挂载后读会话文件补数据，而 pi 延迟写盘、此时文件里往往一条消息都没有。三者叠加
   * 的结果就是「新会话发出第一条消息后对话区空白，要等本轮跑完/刷新才看到」。
   * 记下草稿窗格当时的键并让该会话首次渲染时复用它，就能原地续用同一个实例。键仍然
   * 唯一（每个草稿都伴随 sessionKey 递增），不影响其他会话的切换重挂载。
   */
  const promotedPaneKeys = useRef(new Map<string, string>());
  /** 草稿窗格最后一次渲染时实际用的组件键（转正时 newSessionCwd 已被置空，不能当场重算）。 */
  const draftKeyRef = useRef<string | null>(null);
  const handleSessionCreated = useCallback((created: SessionInfo) => {
    if (draftKeyRef.current) promotedPaneKeys.current.set(created.id, draftKeyRef.current);
    onSessionCreated?.(created);
  }, [onSessionCreated]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { leaves, dividers } = useMemo(
    () => computeLayout(layout, { w: containerSize.w, h: containerSize.h }),
    [layout, containerSize.w, containerSize.h],
  );

  /** Resolve whether a tab's session is currently running. */
  const isTabRunning = useCallback((tabKey: string): boolean => {
    const id = tabKey === `session:${session?.id}` ? session?.id : openTabs.find((o) => o.key === tabKey)?.session.id;
    return Boolean(runningSessionIds?.has(id ?? ""));
  }, [session, openTabs, runningSessionIds]);

  const renderPane = (leaf: Extract<Layout, { kind: "leaf" }>) => {
    // Only the focused pane forwards reports; non-focused panes store them locally.
    const renderChat = (s: SessionInfo | null, opts: { key: string; isNew: boolean }) => {
      const focusedHere = leaf.pane.tabs[leaf.pane.active] === focusedTabKey;
      if (s && s.teamId && s.teamUiMode === "team") {
        return <TeamChat key={opts.key} sessionId={s.id} teamName={s.teamName ?? s.name} onOpenFile={onOpenFile} />;
      }
      return (
        <ChatWindow
          key={opts.key}
          session={s}
          newSessionCwd={opts.isNew ? newSessionCwd : null}
          onAgentEnd={onAgentEnd}
          onSessionCreated={handleSessionCreated}
          onSessionForked={onSessionForked}
          modelsRefreshKey={modelsRefreshKey}
          chatInputRef={focusedHere ? chatInputRef : undefined}
          onBranchDataChange={focusedHere ? handleFocusedBranch : ((tree, al, olc) => { getReports(leaf.pane.tabs[leaf.pane.active]).branch = { tree, activeLeafId: al, onLeafChange: olc }; })}
          onSystemPromptChange={focusedHere ? handleFocusedSystemPrompt : ((p) => { getReports(leaf.pane.tabs[leaf.pane.active]).systemPrompt = p; })}
          onSessionStatsChange={focusedHere ? handleFocusedStats : ((st) => { getReports(leaf.pane.tabs[leaf.pane.active]).stats = st; })}
          onSessionStatsPanelOpen={onSessionStatsPanelOpen}
          onContextUsageChange={focusedHere ? handleFocusedContext : ((c) => { getReports(leaf.pane.tabs[leaf.pane.active]).context = c; })}
          onOpenFile={onOpenFile}
          onOpenWebUrl={onOpenWebUrl}
          onOpenChangedFile={onOpenChangedFile}
          jumpTarget={focusedHere ? jumpTarget : undefined}
          aiEditContext={focusedHere ? aiEditContext : undefined}
          onAiEditContextConsumed={onAiEditContextConsumed}
          fullWidth={fullWidth}
        />
      );
    };

    const tabKey = leaf.pane.tabs[leaf.pane.active] ?? null;
    if (tabKey === null) return <PaneEmpty key={leaf.id} />;
    const draftPaneKey = `new:${newSessionCwd ?? ""}:${sessionKey ?? 0}`;
    // 转正瞬间：布局标签还停在草稿键 "new"，但 session 已经是刚创建的会话（AppShell 已
    // 把 newSessionCwd 置空）。沿用草稿窗格之前那个键继续渲染真实会话，不空一帧也不重挂载。
    if (tabKey === "new" && session && draftKeyRef.current
      && promotedPaneKeys.current.get(session.id) === draftKeyRef.current) {
      return renderChat(session, { key: draftKeyRef.current, isNew: false });
    }
    const isNew = tabKey === "new" || (tabKey === "primary" && !session);
    const s = resolveSession(tabKey);
    if (isNew && !s) {
      if (tabKey === primaryTabKey) return <PaneEmpty key={leaf.id} />;
      draftKeyRef.current = draftPaneKey;
      return renderChat(null, { key: draftPaneKey, isNew: true });
    }
    if (!s) return <PaneEmpty key={leaf.id} />;
    const focusedHere = tabKey === focusedTabKey;
    return renderChat(s, { key: focusedHere ? (promotedPaneKeys.current.get(s.id) ?? `focus:${s.id}:${sessionKey ?? 0}`) : `tab:${s.id}`, isNew: false });
  };

  const leafNodes = useMemo(
    () => collectLeaves(layout).filter((l): l is Extract<Layout, { kind: "leaf" }> => l.kind === "leaf"),
    [layout],
  );

  /** Tabs shown in a pane's tab bar — its own session group, never shared with other panes. */
  const paneTabsFor = useCallback((leaf: Extract<Layout, { kind: "leaf" }>): PaneTabItem[] =>
    leaf.pane.tabs.map((key, i) => ({
      key,
      label: tabLabelFor(key),
      isActive: i === leaf.pane.active,
      isRunning: isTabRunning(key),
    })),
    [tabLabelFor, isTabRunning],
  );

  /** Tapping a tab in a pane focuses it (switching the group's active tab); never opens a detail card. */
  const handlePaneActivate = useCallback((key: string) => {
    if (key === focusedTabKey) return;
    focusTab(key);
  }, [focusedTabKey, focusTab]);

  const handlePaneClose = useCallback((key: string) => { closeTab(key); }, [closeTab]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden" }}>

      {/* Pane container */}
      <div
        ref={containerRef}
        style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden", background: "var(--bg)" }}
      >
        {leafNodes.map((leaf) => {
          const rect = leaves.get(leaf.id);
          if (!rect) return null;
          const isDropping = dropTarget?.leafId === leaf.id;
          const zone = dropTarget?.leafId === leaf.id ? dropTarget.zone : null;
          const style: CSSProperties = {
            position: "absolute",
            left: rect.left + 1,
            top: rect.top + 1,
            width: Math.max(0, rect.width - 2),
            height: Math.max(0, rect.height - 2),
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
            boxShadow: isDropping ? "inset 0 0 0 2px var(--accent)" : "none",
            transition: isDropping ? "box-shadow 0.1s" : "none",
          };
          return (
            <div
              key={leaf.id}
              style={style}
              onDragOver={handleDropZoneEnter(leaf.id)}
              onDragLeave={handleDropZoneLeave}
              onDrop={handleDrop(leaf.id)}
            >
              <PaneTabBar
                tabs={paneTabsFor(leaf)}
                onActivate={handlePaneActivate}
                onClose={handlePaneClose}
                onTabDragStart={handleTabDragStart}
                onTabDrag={handleDrag}
                onTabDragEnd={handleDragEnd}
              />
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{renderPane(leaf)}</div>

              {isDropping && zone && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: "rgba(0,0,0,0.3)",
                    zIndex: 30,
                    pointerEvents: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {zone.dir === "center" ? (
                    <div style={{ padding: "8px 14px", background: "var(--bg-selected)", color: "var(--text)", borderRadius: 6, fontSize: 12 }}>
                      {t("workspace.moveHere")}
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 10 }}>
                      {(["H", "V"] as Dir[]).map((d) => (
                        <div key={d} style={{
                          width: 28, height: 28, borderRadius: 4,
                          background: zone.dir === d ? "var(--accent)" : "var(--bg-selected)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          transition: "background 0.1s",
                        }}>
                          {d === "H" ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={zone.dir === d ? "#fff" : "currentColor"} strokeWidth="2.5" strokeLinecap="round">
                              <line x1="12" y1="3" x2="12" y2="21" />
                            </svg>
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={zone.dir === d ? "#fff" : "currentColor"} strokeWidth="2.5" strokeLinecap="round">
                              <line x1="3" y1="12" x2="21" y2="12" />
                            </svg>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Split dividers */}
        {dividers.map((d) => (
          <ResizeDivider key={d.id} divider={d} onResize={handleDividerResize} />
        ))}

        {/* Drag ghost */}
        {dragGhost && (
          <div
            style={{
              position: "fixed",
              left: dragGhost.x + 8,
              top: dragGhost.y + 8,
              zIndex: 1000,
              pointerEvents: "none",
              padding: "4px 10px",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
              color: "var(--text)",
              fontSize: 12,
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {dragGhost.label}
          </div>
        )}
      </div>
    </div>
  );
}

interface ResizeDividerProps {
  divider: Divider;
  onResize: (divider: Divider, deltaPx: number) => void;
}

function ResizeDivider({ divider, onResize }: ResizeDividerProps) {
  const { t } = useI18n();
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
    const start = divider.orientation === "v" ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const delta = (divider.orientation === "v" ? ev.clientX : ev.clientY) - start;
      onResize(divider, delta);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [divider, onResize]);

  const [hover, setHover] = useState(false);

  const isV = divider.orientation === "v";
  return (
    <div
      role="separator"
      aria-orientation={isV ? "vertical" : "horizontal"}
      title={t("layout.resizeHint")}
      onPointerDown={handlePointerDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute",
        left: divider.x,
        top: divider.y,
        width: divider.w,
        height: divider.h,
        zIndex: 20,
        cursor: isV ? "col-resize" : "row-resize",
        background: dragging ? "color-mix(in srgb, var(--accent) 18%, transparent)" : "transparent",
        touchAction: "none",
      }}
    >
      {/* Visible separator line (default hairline, tinted on hover/drag). */}
      <div
        style={{
          position: "absolute",
          background: dragging ? "var(--accent)" : hover ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--hairline)",
          transition: "background 0.15s",
          ...(isV
            ? { left: "50%", top: 0, bottom: 0, width: 1, transform: "translateX(-50%)", cursor: "col-resize" }
            : { top: "50%", left: 0, right: 0, height: 1, transform: "translateY(-50%)", cursor: "row-resize" }),
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Per-pane tab bar (IDEA-style editor group).                         */
/* ------------------------------------------------------------------ */

interface PaneTabItem {
  key: string;
  label: string;
  isActive: boolean;
  isRunning: boolean;
}

interface PaneTabBarProps {
  tabs: PaneTabItem[];
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onTabDragStart: (e: React.DragEvent, key: string) => void;
  onTabDrag: (e: React.DragEvent) => void;
  onTabDragEnd: () => void;
}

function PaneTabBar({ tabs, onActivate, onClose, onTabDragStart, onTabDrag, onTabDragEnd }: PaneTabBarProps) {
  const { t } = useI18n();
  const barRef = useRef<HTMLDivElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const [overflowCount, setOverflowCount] = useState(0);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowPos, setOverflowPos] = useState<{ top: number; right: number } | null>(null);

  // Measure overflow per bar so clipped tabs collapse into a "⋯" menu.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => {
      const ts = Array.from(el.querySelectorAll<HTMLElement>("[data-ws-tab]"));
      const clientW = el.clientWidth;
      const fullW = el.scrollWidth;
      if (ts.length === 0 || fullW <= clientW) { setOverflowCount(0); return; }
      const reserve = 40;
      let w = 0; let fit = 0;
      for (let i = 0; i < ts.length; i++) {
        if (w + ts[i].offsetWidth > clientW - reserve) break;
        w += ts[i].offsetWidth; fit = i + 1;
      }
      setOverflowCount(Math.max(0, ts.length - fit));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);

  return (
    <>
      <div
        ref={barRef}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "flex-end",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--hairline)",
          overflow: "hidden",
          flexShrink: 0,
          height: 36,
        }}
      >
        {tabs.map((tab) => (
          <div
            key={tab.key}
            data-ws-tab
            draggable
            onDragStart={(e) => onTabDragStart(e, tab.key)}
            onDrag={onTabDrag}
            onDragEnd={onTabDragEnd}
            onClick={() => onActivate(tab.key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 36,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--hairline)",
              background: tab.isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: 12,
              color: tab.isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 220,
              minWidth: 90,
              flexShrink: 0,
              userSelect: "none",
              transition: "background 0.1s, color 0.1s",
            }}
            title={tab.isRunning ? `${tab.label} · ${t("activity.running")}` : tab.label}
          >
            <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: tab.isActive ? 1 : 0.7, color: tab.isRunning ? "var(--accent)" : "currentColor" }}>
              {tab.isRunning ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              )}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1, fontWeight: tab.isActive ? 500 : 400 }}>{tab.label}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(tab.key); }}
              title={t("i18n.close")}
              aria-label={`${t("i18n.close")} ${tab.label}`}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, padding: 0, flexShrink: 0,
                background: "transparent", border: "none", borderRadius: 4,
                color: "var(--text-dim)", cursor: "pointer",
                transition: "background 0.1s, color 0.1s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        ))}
        <div style={{ flex: 1, minWidth: 0 }} />
        {overflowCount > 0 && (
          <div
            style={{
              position: "absolute",
              right: 0, top: 0, bottom: 0, width: 40,
              display: "flex", alignItems: "flex-end", justifyContent: "center",
              background: "linear-gradient(90deg, transparent, var(--bg-panel) 34%, var(--bg-panel) 100%)",
              zIndex: 10,
            }}
          >
            <button
              ref={overflowBtnRef}
              onClick={() => {
                if (!overflowOpen) {
                  const rect = overflowBtnRef.current?.getBoundingClientRect();
                  if (rect) setOverflowPos({ top: rect.bottom + 2, right: window.innerWidth - rect.right });
                }
                setOverflowOpen((v) => !v);
              }}
              title={t("workspace.moreTabs")}
              aria-label={t("workspace.moreTabs")}
              aria-pressed={overflowOpen}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 26, height: 36, padding: 0, flexShrink: 0,
                background: overflowOpen ? "var(--bg-selected)" : "transparent",
                border: "none", color: "var(--text-muted)", cursor: "pointer",
                transition: "color 0.1s, background 0.1s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
            </button>
          </div>
        )}
      </div>

      {overflowOpen && overflowCount > 0 && overflowPos && createPortal(
        <div
          style={{
            position: "fixed",
            top: overflowPos.top,
            right: overflowPos.right,
            zIndex: 1000,
            minWidth: 200, maxWidth: 320,
            maxHeight: 320, overflowY: "auto",
            background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.2)", padding: 4,
          }}
          onMouseLeave={() => setOverflowOpen(false)}
        >
          {tabs.slice(tabs.length - overflowCount).map((tab) => (
            <div
              key={tab.key}
              onClick={() => { onActivate(tab.key); setOverflowOpen(false); }}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 8px", borderRadius: 6, cursor: "pointer",
                background: tab.isActive ? "var(--bg-selected)" : "transparent",
                fontSize: 12, color: "var(--text)", whiteSpace: "nowrap",
              }}
            >
              <span style={{ flexShrink: 0, color: tab.isRunning ? "var(--accent)" : "var(--text-dim)" }}>
                {tab.isRunning ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                )}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1, fontWeight: tab.isActive ? 500 : 400 }}>{tab.label}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onClose(tab.key); }}
                title={t("i18n.close")}
                aria-label={`${t("i18n.close")} ${tab.label}`}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 22, height: 22, padding: 0, flexShrink: 0,
                  background: "transparent", border: "none", borderRadius: 4,
                  color: "var(--text-dim)", cursor: "pointer",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-dim)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg>
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Empty pane (no session selected) — keeps the tab bar but shows a bare background. */
function PaneEmpty() {
  const { t } = useI18n();
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
      {t("sidebar.selectSession")}
    </div>
  );
}
