"use client";

import { useEffect, useState, useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { DirectoryPicker } from "./DirectoryPicker";
import { DraggableResizableModal } from "./DraggableResizableModal";
import { getFileName } from "@/lib/file-paths";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  /** 新建项目组（create 模式）：传入选中的工作目录 */
  onCreateTeam?: (cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  onRunningSessionsChange?: (ids: Set<string>) => void;
  onUnreadSessionsChange?: (count: number) => void;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const RUNNING_SESSIONS_POLL_MS = 2500;

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

const PINNED_SESSIONS_STORAGE_KEY = "pi-web:pinned-session-ids";

// 客户端临时会话 id：新会话懒创建，发首条消息时才真正 spawn pi。
function createTempSessionId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// 隐藏的项目：projectRoot 集合。仅从侧栏项目列表移除，不删除任何会话数据；
// 「添加项目」下拉里可恢复显示。
const HIDDEN_PROJECTS_STORAGE_KEY = "pi-web:hidden-project-roots";

function loadHiddenProjectRoots(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(HIDDEN_PROJECTS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveHiddenProjectRoots(roots: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (roots.size === 0) window.localStorage.removeItem(HIDDEN_PROJECTS_STORAGE_KEY);
    else window.localStorage.setItem(HIDDEN_PROJECTS_STORAGE_KEY, JSON.stringify([...roots]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

function loadPinnedSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(PINNED_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function savePinnedSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(PINNED_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
}

// 项目显示名别名：projectRoot -> 用户自定义名称；清空/删除条目即回退到文件夹名。
const PROJECT_ALIASES_STORAGE_KEY = "pi-web:project-aliases";

function loadProjectAliases(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PROJECT_ALIASES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function saveProjectAliases(aliases: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(aliases).length === 0) window.localStorage.removeItem(PROJECT_ALIASES_STORAGE_KEY);
    else window.localStorage.setItem(PROJECT_ALIASES_STORAGE_KEY, JSON.stringify(aliases));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

type SessionTimeBucket = "today" | "yesterday" | "week" | "older";

function sessionTimeBucket(modified: string, now: Date): SessionTimeBucket {
  const t = new Date(modified).getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfWeek = startOfToday - 6 * 86400000;
  if (t >= startOfToday) return "today";
  if (t >= startOfYesterday) return "yesterday";
  if (t >= startOfWeek) return "week";
  return "older";
}

function flattenSessionTree(tree: SessionTreeNode[]): Array<{ node: SessionTreeNode; depth: number }> {
  const out: Array<{ node: SessionTreeNode; depth: number }> = [];
  const walk = (nodes: SessionTreeNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ node: n, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

function formatSessionTime(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const t = d.getTime();
  const sameYear = d.getFullYear() === now.getFullYear();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (t >= startOfToday.getTime()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameYear) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${String(d.getFullYear()).slice(-2)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Return all projects (deduped by projectRoot so worktrees collapse into their
 * main repo) sorted by most recent session activity.
 */
function getRecentProjects(sessions: SessionInfo[]): string[] {
  const latestByRoot = new Map<string, string>(); // projectRoot -> most recent modified
  for (const s of sessions) {
    const root = s.projectRoot ?? s.cwd;
    if (!root) continue;
    const prev = latestByRoot.get(root);
    if (!prev || s.modified > prev) {
      latestByRoot.set(root, s.modified);
    }
  }
  return [...latestByRoot.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([root]) => root);
}

function normalizeProjectPath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 项目列表 = 会话派生 ∪ 「添加项目」登记表（/api/projects/registered）。
 * 去重用统一分隔符 + 大小写不敏感比较（与 /api/projects/delete 的路径比较规则一致），
 * 防止同一目录因斜杠方向/大小写差异出现两行；会话派生的拼写优先（它来自 pi 实际使用的 cwd）。
 */
function unionProjects(sessionProjects: string[], registered: string[]): string[] {
  if (registered.length === 0) return sessionProjects;
  const seen = new Set(sessionProjects.map(normalizeProjectPath));
  const out = [...sessionProjects];
  for (const p of registered) {
    const key = normalizeProjectPath(p);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}



interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, onCreateTeam, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onRunningSessionsChange, onUnreadSessionsChange }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  // Date groups default: only today (and the curated Pinned group) expanded.
  // Collapsed groups don't render their session items, so 100s of sessions
  // don't mount until the user expands the group (reduces content loading).
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set(["pinned", "today"]));
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(() => loadPinnedSessionIds());
  const [hiddenProjectRoots, setHiddenProjectRoots] = useState<Set<string>>(() => loadHiddenProjectRoots());
  // 「添加项目」持久登记的服务端列表（lib/registered-projects.ts）——
  // 会话派生之外的项目来源，实现「添加即显示、重启仍在」。响应到达后与本地乐观状态收敛。
  const [registeredProjects, setRegisteredProjects] = useState<string[]>([]);
  // 项目列表显示名：优先用户别名，否则取路径最后一级文件夹名；hover 行内铅笔可编辑。
  const [projectAliases, setProjectAliases] = useState<Record<string, string>>(() => loadProjectAliases());
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  // 删除项目确认弹窗状态
  const [removeProjectTarget, setRemoveProjectTarget] = useState<string | null>(null);
  const [removeClearData, setRemoveClearData] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const projectRenameInputRef = useRef<HTMLInputElement>(null);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSessions = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoading(true);
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[]; registeredProjects?: string[] };
      setAllSessions(data.sessions);
      setRegisteredProjects(data.registeredProjects ?? []);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      const existingIds = new Set(data.sessions.map((s) => s.id));
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => existingIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  // Persist pinned sessions.
  useEffect(() => {
    savePinnedSessionIds(pinnedSessionIds);
  }, [pinnedSessionIds]);

  // Persist hidden projects (list-only removal; session data is untouched).
  useEffect(() => {
    saveHiddenProjectRoots(hiddenProjectRoots);
  }, [hiddenProjectRoots]);

  // Persist project display-name aliases.
  useEffect(() => {
    saveProjectAliases(projectAliases);
  }, [projectAliases]);

  // Report running/unread state up to AppShell for the activity-bar dots.
  useEffect(() => {
    onRunningSessionsChange?.(runningSessionIds);
  }, [runningSessionIds, onRunningSessionsChange]);
  useEffect(() => {
    onUnreadSessionsChange?.(unreadSessionIds.size);
  }, [unreadSessionIds, onUnreadSessionsChange]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as { runningSessionIds?: string[] };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const runningIds = [...runningSessionIds];
    const newlyStarted = runningIds.filter((id) => !previous.has(id));

    if (completedInBackground.length > 0 || runningIds.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningIds.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    // 新会话开始运行时立即刷新列表：pi 延迟写盘（首条 assistant 消息之前没有
    // .jsonl 文件），单靠 refreshKey 那次拉取常拿不到；这里补一次拉取，
    // 让「新会话发首条消息」后侧栏秒出条目并带运行状态。
    if (completedInBackground.length > 0 || newlyStarted.length > 0) {
      loadSessions(false);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, loadSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  const restoredRef = useRef(false);

  /** Resolve the project root for a cwd from the freshest data available */
  const projectRootFor = useCallback((cwd: string | null): string | null => {
    if (!cwd) return null;
    const match = allSessions.find((s) => s.cwd === cwd);
    return match?.projectRoot ?? cwd;
  }, [allSessions]);

  // Notify parent only when the effective cwd actually changes (not when
  // projectRootFor identity changes due to session/worktree refreshes).
  const lastNotifiedCwdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastNotifiedCwdRef.current === selectedCwd) return;
    lastNotifiedCwdRef.current = selectedCwd;
    onCwdChange?.(selectedCwd, projectRootFor(selectedCwd));
  }, [selectedCwd, onCwdChange, projectRootFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if ((allSessions.length === 0 && registeredProjects.length === 0) || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = unionProjects(getRecentProjects(allSessions), registeredProjects)
        .filter((p) => !hiddenProjectRoots.has(p));
      if (projects.length > 0) setSelectedCwd(projects[0]);
    }
  }, [allSessions, registeredProjects, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone, hiddenProjectRoots]);

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const cwd = data.cwd ?? path;
      setSelectedCwd(cwd);
      // 添加即显示：本地立即上列表，并持久登记到数据目录（失败不影响本次选择）
      setRegisteredProjects((prev) => (prev.includes(cwd) ? prev : [cwd, ...prev]));
      void fetch("/api/projects/registered", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      })
        .then((r) => r.json().catch(() => null))
        .then((registered) => {
          const projects = (registered as { projects?: unknown } | null)?.projects;
          if (Array.isArray(projects)) setRegisteredProjects(projects as string[]);
        })
        .catch(() => { /* ignore */ });
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
        // DirectoryPicker portals to document.body, so any click inside it lands
        // "outside" dropdownRef. While the picker is open let it manage its own
        // dismissal (backdrop click / Esc / Cancel) — closing it here would kill
        // it on the very first mousedown, before the user can pick a folder.
        if (!customPathOpen) {
          setCustomPathOpen(false);
          setCustomPathError(null);
        }
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [customPathOpen]);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s);
  }, [onSelectSession]);

  const togglePin = useCallback((id: string) => {
    setPinnedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startProjectRename = useCallback((project: string) => {
    setRenamingProject(project);
    // 预填当前显示名（别名或文件夹名），直接全选便于覆盖输入
    setProjectRenameValue(projectAliases[project] ?? getFileName(project) ?? project);
    setTimeout(() => projectRenameInputRef.current?.select(), 0);
  }, [projectAliases]);

  // 提交重命名：空值 = 清除别名，回退到默认文件夹名
  const commitProjectRename = useCallback(() => {
    const key = renamingProject;
    setRenamingProject(null);
    if (!key) return;
    const name = projectRenameValue.trim();
    setProjectAliases((prev) => {
      if (!name) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key] === name) return prev;
      return { ...prev, [key]: name };
    });
  }, [renamingProject, projectRenameValue]);

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    onNewSession?.(createTempSessionId(), selectedCwd);
  }, [selectedCwd, onNewSession]);

  // 项目行上的「+」：直接为该项目新建会话（不用先选中项目再点顶部按钮）
  const handleNewSessionInProject = useCallback((project: string) => {
    setSelectedCwd(project);
    onNewSession?.(createTempSessionId(), project);
  }, [onNewSession]);

  // 移除项目：点击垃圾桶 → 确认弹窗（可选是否同时清除会话数据）
  const requestRemoveProject = useCallback((project: string) => {
    setRemoveClearData(false);
    setRemoveProjectTarget(project);
  }, []);

  const confirmRemoveProject = useCallback(async () => {
    const project = removeProjectTarget;
    if (!project || removeBusy) return;
    setRemoveBusy(true);
    try {
      if (removeClearData) {
        // 同时清除该项目的全部会话数据（停掉活跃会话 + 删除 .jsonl）
        const res = await fetch("/api/projects/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectRoot: project }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { deletedIds?: string[] };
        const deletedIds = new Set(data.deletedIds ?? []);
        // 清理本地缓存标记：别名、置顶、未读
        setProjectAliases((prev) => {
          if (!(project in prev)) return prev;
          const next = { ...prev };
          delete next[project];
          return next;
        });
        setPinnedSessionIds((prev) => {
          const next = new Set([...prev].filter((id) => !deletedIds.has(id)));
          return next.size === prev.size ? prev : next;
        });
        setUnreadSessionIds((prev) => {
          const next = new Set([...prev].filter((id) => !deletedIds.has(id)));
          return next.size === prev.size ? prev : next;
        });
        // 当前打开的会话被删 → 通知 AppShell 关闭
        if (selectedSessionId && deletedIds.has(selectedSessionId)) onSessionDeleted?.(selectedSessionId);
        // 移除的是当前项目 → 切到下一个最近项目（无则清空选择）
        if (projectRootFor(selectedCwd) === project) {
          const nextProject = getRecentProjects(
            allSessions.filter((s) => (s.projectRoot ?? s.cwd) !== project),
          ).find((p) => !hiddenProjectRoots.has(p));
          setSelectedCwd(nextProject ?? null);
        }
      } else {
        // 仅从列表隐藏（会话数据保留；下拉菜单可恢复）。
        // 若是「添加项目」持久登记的项目，同步删除登记——否则在本地存储不可靠的
        // 环境（如打包 exe 的随机端口 origin）里它会原地复活。
        if (registeredProjects.includes(project)) {
          setRegisteredProjects((prev) => prev.filter((p) => p !== project));
          void fetch("/api/projects/registered", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd: project }),
          })
            .then((r) => r.json().catch(() => null))
            .then((registered) => {
              const projects = (registered as { projects?: unknown } | null)?.projects;
              if (Array.isArray(projects)) setRegisteredProjects(projects as string[]);
            })
            .catch(() => { /* ignore */ });
        }
        setHiddenProjectRoots((prev) => {
          if (prev.has(project)) return prev;
          const next = new Set(prev);
          next.add(project);
          return next;
        });
        if (projectRootFor(selectedCwd) === project) {
          const nextProject = getRecentProjects(allSessions)
            .find((p) => p !== project && !hiddenProjectRoots.has(p));
          setSelectedCwd(nextProject ?? null);
        }
      }
      setRemoveProjectTarget(null);
      setRemoveClearData(false);
      loadSessions(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoveBusy(false);
    }
  }, [removeProjectTarget, removeBusy, removeClearData, selectedSessionId, onSessionDeleted, selectedCwd, projectRootFor, allSessions, registeredProjects, hiddenProjectRoots, loadSessions]);

  // 恢复显示被隐藏的项目
  const restoreProject = useCallback((project: string) => {
    setHiddenProjectRoots((prev) => {
      if (!prev.has(project)) return prev;
      const next = new Set(prev);
      next.delete(project);
      return next;
    });
  }, []);

  // 点击项目 = 切换到该项目并打开其最近的一个会话；项目还没有会话时
  // 才回落到旧行为（切换 cwd → 空白草稿）。
  const handleProjectClick = useCallback((project: string) => {
    setProjectFilter("");
    setCustomPathOpen(false);
    setCustomPathValue("");
    setCustomPathError(null);
    setDropdownOpen(false);
    if (project === projectRootFor(selectedCwd)) return;
    const latest = allSessions
      .filter((s) => (s.projectRoot ?? s.cwd) === project)
      .sort((a, b) => b.modified.localeCompare(a.modified))[0];
    if (latest) {
      handleSelectSessionFromList(latest);
    } else {
      setSelectedCwd(project);
    }
  }, [selectedCwd, projectRootFor, allSessions, handleSelectSessionFromList]);

  const handleCreateTeam = useCallback(() => {
    if (!selectedCwd || !onCreateTeam) return;
    onCreateTeam(selectedCwd);
  }, [selectedCwd, onCreateTeam]);

  // 每个项目下的会话数量（用于项目列表右侧计数徽标）
  const sessionCountForProject = useCallback((projectRoot: string) => {
    return allSessions.filter((s) => (s.projectRoot ?? s.cwd) === projectRoot).length;
  }, [allSessions]);

  const allKnownProjects = unionProjects(getRecentProjects(allSessions), registeredProjects);
  const recentProjects = allKnownProjects.filter((p) => !hiddenProjectRoots.has(p));
  const hiddenProjects = allKnownProjects.filter((p) => hiddenProjectRoots.has(p));
  const showProjectFilter = recentProjects.length > 8;
  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((p) => p.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects;

  // Sessions of every worktree in the selected project are shown together
  const selectedProject = projectRootFor(selectedCwd);
  const filteredSessions = selectedProject
    ? allSessions.filter((s) => (s.projectRoot ?? s.cwd) === selectedProject)
    : allSessions;

  // Build parent-child tree within the filtered set
  const sessionTree = buildSessionTree(filteredSessions);

  // Flatten into a time-sorted list (fork children kept as indented items).
  const flatTree = flattenSessionTree(sessionTree).sort(
    (a, b) => b.node.session.modified.localeCompare(a.node.session.modified),
  );

  const now = new Date();
  const sessionGroups = (() => {
    const pinned = flatTree.filter(({ node }) => pinnedSessionIds.has(node.session.id));
    const rest = flatTree.filter(({ node }) => !pinnedSessionIds.has(node.session.id));
    const byBucket = (b: SessionTimeBucket) =>
      rest.filter(({ node }) => sessionTimeBucket(node.session.modified, now) === b);
    return [
      { key: "pinned", labelKey: "activity.pinned", items: pinned },
      { key: "today", labelKey: "activity.today", items: byBucket("today") },
      { key: "yesterday", labelKey: "activity.yesterday", items: byBucket("yesterday") },
      { key: "week", labelKey: "activity.past7", items: byBucket("week") },
      { key: "older", labelKey: "activity.older", items: byBucket("older") },
    ];
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {customPathOpen && (
        <DirectoryPicker
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {/* ── 删除项目确认弹窗（可拖动/缩放） ── */}
      {removeProjectTarget && (() => {
        const targetName = projectAliases[removeProjectTarget]
          ?? getFileName(removeProjectTarget)
          ?? removeProjectTarget;
        return (
          <DraggableResizableModal
            title={t("sidebar.deleteProjectTitle")}
            onClose={() => { if (!removeBusy) { setRemoveProjectTarget(null); setRemoveClearData(false); } }}
            width={480}
            height={250}
          >
            <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "16px 18px", boxSizing: "border-box", gap: 14, overflow: "auto" }}>
              <div style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.65 }}>
                {t("sidebar.deleteProjectBody", { name: targetName })}
                <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
                  {t("sidebar.deleteProjectKeepHint")}
                </div>
              </div>
              <div style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 12 }}>
                <label
                  style={{
                    flex: 1, minWidth: 0, display: "flex", alignItems: "flex-start", gap: 8,
                    cursor: removeBusy ? "wait" : "pointer",
                    fontSize: 12, color: "var(--text)", lineHeight: 1.5, userSelect: "none",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={removeClearData}
                    disabled={removeBusy}
                    onChange={(e) => setRemoveClearData(e.target.checked)}
                    style={{ width: 14, height: 14, marginTop: 2, flexShrink: 0, accentColor: "var(--accent)" }}
                  />
                  <span>{t("sidebar.deleteProjectClearData")}</span>
                </label>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => { setRemoveProjectTarget(null); setRemoveClearData(false); }}
                    style={{
                      height: 30, padding: "0 14px",
                      background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)", color: "var(--text-muted)",
                      cursor: "pointer", fontSize: 12,
                      transition: "background 0.12s, color 0.12s",
                    }}
                  >
                    {t("sidebar.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmRemoveProject()}
                    disabled={removeBusy}
                    style={{
                      height: 30, padding: "0 14px",
                      background: removeBusy ? "var(--bg-selected)" : "#ef4444", border: "none",
                      borderRadius: "var(--radius-sm)", color: "#fff",
                      cursor: removeBusy ? "wait" : "pointer", fontSize: 12, fontWeight: 600,
                      opacity: removeBusy ? 0.7 : 1,
                      transition: "background 0.12s, opacity 0.12s",
                    }}
                  >
                    {t("sidebar.delete")}
                  </button>
                </div>
              </div>
            </div>
          </DraggableResizableModal>
        );
      })()}
      {/* ── Action list — Codex-style nav rows (icon + label, no boxes) ── */}
      <div
        style={{
          padding: "8px 8px 2px",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        {/* Add project — directly opens the custom path picker */}
        <div ref={dropdownRef} style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => { setDropdownOpen(false); handleCustomPathClick(); }}
            title={t("sidebar.addProject")}
            style={{
              display: "flex", alignItems: "center", gap: 9, width: "100%",
              padding: "6px 10px", background: "transparent", border: "none", borderRadius: "var(--radius-xs)",
              color: "var(--text)", cursor: "pointer", fontSize: 13, fontWeight: 500, textAlign: "left",
              transition: "background 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <line x1="12" y1="9" x2="12" y2="14" />
              <line x1="9.5" y1="11.5" x2="14.5" y2="11.5" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("sidebar.addProject")}</span>
          </button>

          {/* Restore hidden projects (only shown when some exist) */}
          {hiddenProjects.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setDropdownOpen((v) => !v)}
                title={t("sidebar.hiddenProjects")}
                aria-haspopup="menu"
                aria-expanded={dropdownOpen}
                style={{
                  display: "flex", alignItems: "center", gap: 9, width: "100%",
                  padding: "6px 10px", background: "transparent", border: "none", borderRadius: "var(--radius-xs)",
                  color: "var(--text)", cursor: "pointer", fontSize: 13, fontWeight: 500, textAlign: "left",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                  <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("sidebar.hiddenProjects")}</span>
                <svg
                  width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-muted)"
                  strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
                  style={{ flexShrink: 0, marginLeft: "auto", transform: dropdownOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
                  aria-hidden="true"
                >
                  <polyline points="3 2 7 5 3 8" />
                </svg>
              </button>

              <AnimatedDropdown
                open={dropdownOpen}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  zIndex: 100,
                  minWidth: 180,
                  background: "var(--bg-panel)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  boxShadow: "var(--shadow-md)",
                  padding: 4,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  overflow: "hidden",
                }}
              >
                {hiddenProjects.map((hidden) => (
                  <button
                    key={hidden}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); restoreProject(hidden); }}
                    title={`${hidden} · ${t("sidebar.restoreProject")}`}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%",
                      padding: "6px 10px", background: "transparent", border: "none", borderRadius: "var(--radius-xs)",
                      color: "var(--text)", cursor: "pointer", fontSize: 12, textAlign: "left",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {projectAliases[hidden] ?? getFileName(hidden) ?? hidden}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 10.5, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                      {sessionCountForProject(hidden)}
                    </span>
                  </button>
                ))}
              </AnimatedDropdown>
            </>
          )}
        </div>

        {/* New session */}
        <button
          type="button"
          onClick={handleNewSession}
          disabled={!selectedCwd}
          title={selectedCwd ? t("sidebar.newSessionTitle", { path: selectedCwd }) : t("sidebar.selectProject")}
          style={{
            display: "flex", alignItems: "center", gap: 9, width: "100%",
            padding: "7px 10px", background: "var(--glass-bg)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-md)",
            color: "var(--text)",
            cursor: selectedCwd ? "pointer" : "not-allowed",
            fontSize: 13, fontWeight: 600, textAlign: "left",
            transition: "background 0.12s, opacity 0.12s",
            opacity: selectedCwd ? 1 : 0.45,
            boxShadow: "var(--shadow-xs)",
          }}
          onMouseEnter={(e) => { if (selectedCwd) e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "var(--glass-bg)"; }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.2" strokeLinecap="round" style={{ flexShrink: 0 }} aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("sidebar.newSession")}</span>
        </button>

        {/* New team */}
        <button
          type="button"
          onClick={handleCreateTeam}
          disabled={!selectedCwd}
          title={t("team.sidebar.createTeam")}
          style={{
            display: "flex", alignItems: "center", gap: 9, width: "100%",
            padding: "6px 10px", background: "transparent", border: "none", borderRadius: "var(--radius-xs)",
            color: selectedCwd ? "var(--text)" : "var(--text-dim)",
            cursor: selectedCwd ? "pointer" : "not-allowed",
            fontSize: 13, fontWeight: 500, textAlign: "left",
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(e) => { if (selectedCwd) e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("team.sidebar.createTeam")}</span>
        </button>
      </div>

      {/* ── Projects ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 12px 8px", flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.05em", color: "var(--text)" }}>
          {t("sidebar.projects")}
        </span>
        <span style={{ fontSize: 10.5, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
          {recentProjects.length}
        </span>
        {showProjectFilter && (
          <input
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            placeholder={t("sidebar.filterProjects")}
            style={{
              marginLeft: "auto",
              width: 140,
              fontSize: 11,
              padding: "4px 8px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-xs)",
              outline: "none",
              background: "transparent",
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              boxSizing: "border-box",
              transition: "border-color 0.12s",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
          />
        )}
      </div>
      <div style={{ flexShrink: 0, maxHeight: "min(34vh, 240px)", overflowY: "auto", padding: "0 8px" }}>
        {visibleProjects.map((project) => {
          const isSel = project === selectedProject;
          const count = sessionCountForProject(project);
          const isRenaming = renamingProject === project;
          const isHovered = hoveredProject === project;
          // 显示名：用户别名优先，否则取路径最后一级文件夹名（完整路径见行 title）
          const displayName = projectAliases[project] ?? getFileName(project) ?? project;

          if (isRenaming) {
            return (
              <div
                key={project}
                style={{
                  display: "flex", alignItems: "center", gap: 9, width: "100%",
                  padding: "7px 10px", margin: "2px 0",
                  background: isSel ? "var(--accent-soft)" : "var(--bg-hover)", borderRadius: "var(--radius-xs)",
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                <input
                  ref={projectRenameInputRef}
                  value={projectRenameValue}
                  onChange={(e) => setProjectRenameValue(e.target.value)}
                  onBlur={commitProjectRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitProjectRename();
                    if (e.key === "Escape") setRenamingProject(null);
                  }}
                  autoFocus
                  title={project}
                  style={{
                    flex: 1, minWidth: 0, height: 26,
                    fontSize: 12.5, padding: "4px 8px",
                    border: "1px solid var(--accent)", borderRadius: "var(--radius-xs)",
                    outline: "none", background: "var(--bg)", color: "var(--text)",
                  }}
                />
              </div>
            );
          }

          return (
            <div
              key={project}
              onClick={() => handleProjectClick(project)}
              onDoubleClick={() => { if (!isRenaming) startProjectRename(project); }}
              onMouseEnter={() => setHoveredProject(project)}
              onMouseLeave={() => setHoveredProject((cur) => (cur === project ? null : cur))}
              title={`${project} · ${t("sidebar.projectRenameHint")}`}
              style={{
                display: "flex", alignItems: "center", gap: 9, width: "100%",
                padding: "7px 10px", margin: "2px 0",
                background: isSel ? "var(--accent-soft)" : isHovered ? "var(--bg-hover)" : "transparent",
                borderRadius: "var(--radius-sm)",
                boxShadow: isSel ? "inset 2px 0 0 var(--accent)" : "none",
                color: "var(--text)",
                cursor: "pointer", fontSize: 12.5,
                transition: "background 0.1s",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={isSel ? "var(--accent)" : "var(--text-muted)"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span
                style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {displayName}
              </span>
              <span style={{ flexShrink: 0, fontSize: 10.5, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{count}</span>
              {/* 悬停浮现的「+」（为该项目新建会话）：固定占位 + 淡入，
                  不改变行内布局，避免 hover 抖动。 */}
              <span
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, flexShrink: 0,
                  opacity: isHovered ? 1 : 0,
                  pointerEvents: isHovered ? "auto" : "none",
                  transition: "opacity 0.12s",
                }}
              >
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleNewSessionInProject(project); }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={t("sidebar.newSessionTitle", { path: project })}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 20, height: 20, padding: 0, flexShrink: 0,
                    background: "transparent", border: "none", borderRadius: "var(--radius-xs)",
                    color: "var(--text-muted)", cursor: "pointer",
                    transition: "color 0.12s, background 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "var(--bg-selected)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </span>
              {/* 悬停浮现的「移除」：仅从列表隐藏项目，不删除会话数据 */}
              <span
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, flexShrink: 0,
                  opacity: isHovered ? 1 : 0,
                  pointerEvents: isHovered ? "auto" : "none",
                  transition: "opacity 0.12s",
                }}
              >
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); requestRemoveProject(project); }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={t("sidebar.deleteProjectTitle")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 20, height: 20, padding: 0, flexShrink: 0,
                    background: "transparent", border: "none", borderRadius: "var(--radius-xs)",
                    color: "var(--text-muted)", cursor: "pointer",
                    transition: "color 0.12s, background 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                </button>
              </span>
            </div>
          );
        })}
        {visibleProjects.length === 0 && projectFilter.trim() && (
          <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-muted)" }}>{t("sidebar.noMatchingProjects")}</div>
        )}
        {visibleProjects.length === 0 && !projectFilter.trim() && (
          <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
            {t("sidebar.noProjects")}
          </div>
        )}
      </div>

      {/* ── Sessions ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "16px 14px 8px", flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.05em", color: "var(--text)" }}>
          {t("sidebar.sessions")}
        </span>
        <span style={{ fontSize: 10.5, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
          {filteredSessions.length}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 }}>
          <button
            type="button"
            onClick={() => loadSessions(false)}
            title={t("sidebar.refresh")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, padding: 0,
              background: "none", border: "none", borderRadius: "var(--radius-xs)",
              color: sessionRefreshDone ? "#4ade80" : "var(--text-dim)",
              cursor: "pointer",
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = sessionRefreshDone ? "#4ade80" : "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
          >
            {sessionRefreshDone ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
            )}
          </button>
        </div>
      </div>


      {/* Session list */}
      <div style={{ flex: "1 1 0", overflowY: "auto", padding: "0", minHeight: 80 }}>
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && filteredSessions.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.noSessions")}
          </div>
        )}

        {sessionGroups?.map((group) => {
              const expanded = expandedGroups.has(group.key);
              return (
              <div key={group.key}>
                {group.items.length > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "14px 12px 4px 14px",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-muted)",
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: "0.05em",
                      textAlign: "left",
                      fontFamily: "inherit",
                    }}
                  >
                    <svg
                      width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor"
                      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                      style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.16s", flexShrink: 0 }}
                    >
                      <polyline points="3 2 7 5 3 8" />
                    </svg>
                    <span>{t(group.labelKey)}</span>
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 10.5,
                        fontWeight: 500,
                        color: "var(--text-muted)",
                        fontVariantNumeric: "tabular-nums",
                        letterSpacing: "0.02em",
                      }}
                    >
                      {group.items.length}
                    </span>
                  </button>
                )}
                {expanded && group.items.map(({ node, depth }) => (
                  <SessionItem
                    key={node.session.id}
                    session={node.session}
                    isSelected={node.session.id === selectedSessionId}
                    isRunning={runningSessionIds.has(node.session.id)}
                    isUnread={unreadSessionIds.has(node.session.id)}
                    isPinned={pinnedSessionIds.has(node.session.id)}
                    onClick={() => handleSelectSessionFromList(node.session)}
                    onRenamed={loadSessions}
                    onDeleted={(id) => {
                      onSessionDeleted?.(id);
                      loadSessions();
                    }}
                    onTogglePin={togglePin}
                    depth={depth}
                  />
                ))}
              </div>
              );
            })}
      </div>
    </div>
  );
}

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  isPinned,
  onClick,
  onRenamed,
  onDeleted,
  onTogglePin,
  depth = 0,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  isPinned?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  onTogglePin?: (id: string) => void;
  depth?: number;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 显示名：优先会话名；否则用首条消息片段；空会话（firstMessage 为 "(no messages)" 占位）
  // 时回退到本地化「新会话」，避免露出英文占位（与普通会话新建态一致）。
  const title =
    session.name ||
    (session.firstMessage && session.firstMessage !== "(no messages)"
      ? session.firstMessage.slice(0, 50)
      : "") ||
    t("sidebar.newSession") ||
    session.id.slice(0, 12);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed]);

  const performDelete = useCallback(async () => {
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, onDeleted]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey) {
      void performDelete();
    } else {
      setConfirmDelete(true);
    }
  }, [performDelete]);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows.
  const ITEM_HEIGHT = 40;
  const statusDotColor = isRunning ? "var(--accent)" : isUnread ? "#0891b2" : "var(--border)";

  return (
    <div
      onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      draggable={!confirmDelete && !renaming}
      onDragStart={(e) => {
        if (confirmDelete || renaming) { e.preventDefault(); return; }
        e.dataTransfer.setData("text/pi-session-drag", JSON.stringify(session));
        e.dataTransfer.effectAllowed = "copyMove";
      }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 12 : 12,
        paddingRight: 8,
        margin: "0 6px",
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "color-mix(in srgb, #ef4444 8%, transparent)"
          : isSelected ? "var(--accent-soft)" : hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: "var(--radius-sm)",
        boxShadow: isSelected ? "inset 2px 0 0 var(--accent)" : "none",
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two compact buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 20) + (title.length > 20 ? "…" : "") })}
          </div>
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                height: 24, padding: "0 9px",
                background: "#ef4444", border: "none",
                borderRadius: "var(--radius-xs)", color: "#fff",
                cursor: "pointer", fontSize: 11, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                height: 24, padding: "0 9px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: "var(--radius-xs)", color: "var(--text-muted)",
                cursor: "pointer", fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "4px 8px",
            border: "1px solid var(--accent)",
            borderRadius: "var(--radius-xs)",
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 26,
          }}
        />
      ) : (
        /* ── Normal view: single line ── */
        <>
          <span
            style={{
              width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
              background: statusDotColor,
              boxShadow: isRunning ? "0 0 0 3px var(--accent-soft)" : "none",
            }}
          />
          {depth > 0 && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          )}
          {(session.teamId && session.teamUiMode === "team") && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          )}
          {isPinned && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" style={{ flexShrink: 0, color: "var(--accent)" }} aria-hidden="true">
              <path d="M9 3h6l-1 6 3 3v1H7v-1l3-3z" />
              <path d="M12 13v8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          )}
          <span
            style={{
              flex: 1, minWidth: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              fontSize: 12.5, fontWeight: isSelected ? 550 : 450, lineHeight: 1.4,
              color: "var(--text)",
            }}
            title={title}
          >
            {title}
          </span>
          {isRunning ? (
            <span style={{ flexShrink: 0, fontSize: 10, color: "var(--accent)", fontWeight: 600 }}>
              {t("activity.running")}
            </span>
          ) : (
            <span style={{ flexShrink: 0, fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }} title={session.modified}>
              {formatSessionTime(session.modified)}
            </span>
          )}

          {hovered && (
            <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
              <button
                onClick={(e) => { e.stopPropagation(); onTogglePin?.(session.id); }}
                title={isPinned ? t("activity.unpin") : t("activity.pin")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 24, height: 24, padding: 0,
                  background: isPinned ? "var(--bg-selected)" : "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius-xs)", color: isPinned ? "var(--accent)" : "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = isPinned ? "var(--accent)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 3h6l-1 6 3 3v1H7v-1l3-3z" />
                  <path d="M12 13v8" />
                </svg>
              </button>
              <button
                onClick={startRename}
                title={t("sidebar.rename")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 24, height: 24, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius-xs)", color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-selected)"; e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={handleDeleteClick}
                title={t("sidebar.deleteWithShiftClick")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 24, height: 24, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius-xs)", color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; e.currentTarget.style.color = "#ef4444"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
