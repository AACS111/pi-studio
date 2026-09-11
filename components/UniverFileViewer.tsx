"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { XlsxViewer, warmScopeData } from "./XlsxViewer";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  filePath: string;
  sourceSessionId?: string | null;
}

interface WorktreeInfo {
  id: string;
  status: string;
  name: string;
  headCommit: number;
  commits: Array<{ seq: number; message: string; createdAt: string }>;
  /** Commit seqs created by online user edits (labeled "u" instead of "r"). */
  userSeqs?: number[];
  /** Worktree creation time (ISO) — lets the list sort before the first commit. */
  createdAt?: string;
}

interface UnitInfo {
  unitId: string;
  kind: string;
  name?: string;
}

/** Width of the gateway viewer's built-in left sidebar (Tailwind w-64). NO
 *  LONGER CROPPED (2026-08-27 user report: with DPI/zoom/locale variance the
 *  hard-coded offset cut half the sidebar AND clipped the toolbar — a fixed
 *  pixel value can never match every environment, and the gateway exposes no
 *  URL param to hide the sidebar). The full gateway UI renders instead; it
 *  has its own sidebar-collapse toggle whose state persists in the gateway's
 *  localStorage, so users who want the full width collapse it once. */

const UNIT_KIND_COLORS: Record<string, string> = {
  sheet: "#2a7aff",
  doc: "#7c5cff",
  slide: "#f59e0b",
  base: "#14b8a6",
  board: "#ec4899",
};

const STATUS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  draft: { label: "编辑中", bg: "#e6f7ee", color: "#1a7f4b" },
  active: { label: "编辑中", bg: "#e6f7ee", color: "#1a7f4b" },
  ready: { label: "待合并", bg: "#fff4e0", color: "#b7791f" },
  merged: { label: "已合并", bg: "#f0f0f0", color: "#666" },
  discarded: { label: "已丢弃", bg: "#f0f0f0", color: "#666" },
};

function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Viewer for Univer CLI `.univer` files, styled after the CLI's viewer:
 * left file/version panel + top operation bar (合并当前版本 / 丢弃) + Univer
 * sheet. Polls worktree list so agent edits via `univer execute` appear
 * automatically; merge/discard call the CLI through /api/univer/*.
 */
export function UniverFileViewer({ filePath, sourceSessionId }: Props) {
  const { t } = useI18n();
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // null = trunk
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // Whole left panel collapsed to a slim rail (user request 2026-08-08).
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [trunkRev, setTrunkRev] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const signatureRef = useRef("");
  const worktreesRef = useRef<WorktreeInfo[]>([]);
  // Revision the viewer has already applied for each scope ("wt:<id>" | "trunk").
  // Advanced ONLY when the poll sees a NON-own change, so our own auto-saves
  // never re-sync the grid (the local baseline already has them).
  const ackRevRef = useRef<Record<string, number>>({});
  const prevTrunkRevRef = useRef(0);
  // Set by XlsxViewer after its own auto-save; lets the poll skip the reload
  // for exactly that change (the local baseline is already up to date).
  const ownSaveRef = useRef<number | null>(null);

  // Multi-unit support: a .univer file can hold Sheet / Doc / Slide / Base /
  // Board units. Sheets stay on the native XlsxViewer; every other kind embeds
  // the official version-matched viewer served by the univer-cli daemon.
  const [units, setUnits] = useState<UnitInfo[]>([]);
  // False until the first unit list resolves — pure doc/slide/base/board files
  // must NOT mount XlsxViewer at all (its /api/unifer/view export fails with
  // "cannot export doc unit as xlsx"), so we wait before rendering it.
  const [unitsReady, setUnitsReady] = useState(false);
  const [activeUnitId, setActiveUnitId] = useState<string | null>(null);
  const [unitFrame, setUnitFrame] = useState<{ status: "loading" | "error" | "ok"; url?: string } | null>(null);
  // Export button (pill-row, slide/doc units): busy flag + inline feedback.
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const unitUrlCacheRef = useRef<Map<string, string>>(new Map());
  // Bumped when the poll sees the trunk rewritten EXTERNALLY (agent commit /
  // worktree merge). The gateway iframe renders a snapshot of the file, so it
  // must remount to show merged content — doc/slide files have no pi-studio
  // auto-save path, so every trunk mtime bump is external.
  const [gatewayReloadTick, setGatewayReloadTick] = useState(0);

  const fileName = filePath.split(/[\\/]/).pop() || "sheet.univer";

  const loadWorktrees = useCallback(async (): Promise<{ worktrees: WorktreeInfo[]; trunkRev: number }> => {
    try {
      const response = await fetch(`/api/univer/worktrees?file=${encodeURIComponent(filePath)}`);
      if (!response.ok) return { worktrees: [], trunkRev: 0 };
      const data = await response.json() as { worktrees?: WorktreeInfo[]; trunkRev?: number };
      return {
        worktrees: data.worktrees ?? [],
        trunkRev: typeof data.trunkRev === "number" ? data.trunkRev : 0,
      };
    } catch {
      return { worktrees: [], trunkRev: 0 };
    }
  }, [filePath]);

  // Initial load + poll: when the CLI commits (file changes on disk), the
  // worktree signature changes and we refresh the panel AND the viewer.
  // Only update state when the signature actually changes — otherwise the
  // fresh array each poll re-triggers the warm-cache effect and hammers the
  // CLI with an export per worktree every 5s.
  useEffect(() => {
    let cancelled = false;
    const firstRunRef = { first: true };

    const poll = async () => {
      const { worktrees: list, trunkRev: trunkMtime } = await loadWorktrees();
      if (cancelled) return;
      const signature = `${trunkMtime}|${list.map((w) => `${w.id}:${w.status}:${w.headCommit}`).join("|")}`;
      const changed = signature !== signatureRef.current;
      const prevList = worktreesRef.current;
      signatureRef.current = signature;
      worktreesRef.current = list;
      if (firstRunRef.first) {
        // Initial mount: populate the list (and warm caches) but skip the
        // sync — the viewer already loaded with the fetched data.
        firstRunRef.first = false;
        setWorktrees(list);
        setTrunkRev(trunkMtime);
        ackRevRef.current.trunk = trunkMtime;
        prevTrunkRevRef.current = trunkMtime;
        return;
      }
      if (!changed) return;
      // Skip the viewer sync when the only change is our own auto-save on the
      // selected scope (worktree headCommit matches ownSaveRef) — the
      // local baseline is already updated, so syncing would just reset the
      // user's view.
      // 历史 bug 备注（2026-08-28）：这里曾有 trunk 分支用 trunkMtime === ownSaveRef
      // 判定「自己的 trunk 自动保存」——但 ownSaveRef 存的是 worktree commit 的 seq
      //（小整数），trunkMtime 是 epoch 毫秒，永不相等；且 viewer 编辑走 worktree-only
      // 策略（无工作区自动建区切走），代码库里也不存在「pi-auto staging merge」通道
      //（全文仅剩这条注释）——trunk 从不被 viewer 自写，trunk mtime 变化都是真实
      // 外部变更（agent 合并/用户点击合并），理应同步。故删除该死分支。
      let ownOnly = false;
      if (ownSaveRef.current != null) {
        if (selected) {
          const prevMap = new Map(prevList.map((w) => [w.id, w]));
          const newMap = new Map(list.map((w) => [w.id, w]));
          const allIds = new Set([...prevMap.keys(), ...newMap.keys()]);
          const changedIds = new Set<string>();
          for (const id of allIds) {
            const p = prevMap.get(id);
            const n = newMap.get(id);
            if ((p ? `${p.id}:${p.status}:${p.headCommit}` : "") !== (n ? `${n.id}:${n.status}:${n.headCommit}` : "")) {
              changedIds.add(id);
            }
          }
          const sel = newMap.get(selected);
          ownOnly =
            changedIds.size === 1 &&
            changedIds.has(selected) &&
            !!sel &&
            sel.headCommit === ownSaveRef.current;
        }
      }
      setWorktrees(list);
      setTrunkRev(trunkMtime);
      if (!ownOnly) {
        // Advance the acknowledged revision of the VIEWED scope only when its
        // own content changed externally (worktree commit / trunk merge).
        // Status-only changes and commits to OTHER worktrees don't re-sync the
        // grid — that's the main source of the old reload-everything behavior.
        if (selected) {
          const prevInfo = prevList.find((w) => w.id === selected);
          const newInfo = list.find((w) => w.id === selected);
          if ((prevInfo?.headCommit ?? 0) !== (newInfo?.headCommit ?? 0)) {
            ackRevRef.current[`wt:${selected}`] = newInfo?.headCommit ?? 0;
          }
        } else if (trunkMtime !== prevTrunkRevRef.current) {
          ackRevRef.current.trunk = trunkMtime;
        }
        // Any worktree newly merged (or deleted) rewrites trunk content —
        // invalidate the trunk cache regardless of what is currently viewed,
        // so switching back to trunk is always fresh.
        const mergeOrDelete =
          list.some((w) => {
            const p = prevList.find((x) => x.id === w.id);
            return p && p.status !== "merged" && w.status === "merged";
          }) ||
          prevList.some((w) => !list.some((x) => x.id === w.id));
        if (mergeOrDelete) ackRevRef.current.trunk = trunkMtime;
      }
      if (!ownOnly && trunkMtime !== prevTrunkRevRef.current) {
        setGatewayReloadTick((k) => k + 1);
      }
      prevTrunkRevRef.current = trunkMtime;
    };

    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadWorktrees, selected]);

  // Reset the own-save marker whenever the scope changes or the viewer reloads
  // (a reload means external data arrived; the marker is only meaningful for
  // the current edit cycle).
  useEffect(() => {
    ownSaveRef.current = null;
  }, [selected, refreshKey]);

  // ── Multi-unit: load the unit list for the current scope ──────────────
  const loadUnits = useCallback(async (): Promise<UnitInfo[]> => {
    try {
      const params = new URLSearchParams({ file: filePath });
      if (selected) params.set("worktree", selected);
      const response = await fetch(`/api/univer/units?${params.toString()}`);
      if (!response.ok) return [];
      const data = await response.json() as { units?: UnitInfo[] };
      return Array.isArray(data.units) ? data.units : [];
    } catch {
      return [];
    }
  }, [filePath, selected]);

  // Refresh on scope change / manual refresh / merge (trunkRev bumps). If the
  // active unit no longer exists in this scope, fall back to the sheet view.
  useEffect(() => {
    let cancelled = false;
    void loadUnits().then((list) => {
      if (cancelled) return;
      setUnits(list);
      setUnitsReady(true);
    });
    return () => { cancelled = true; };
  }, [loadUnits, refreshKey, trunkRev]);

  useEffect(() => {
    setActiveUnitId((prev) => (prev && units.some((u) => u.unitId === prev) ? prev : null));
  }, [units]);

  // Files with NO sheet unit (docx/pptx imports): auto-select the first
  // non-sheet unit once known — there is no grid to fall back to.
  useEffect(() => {
    if (!unitsReady || units.length === 0 || units.some((u) => u.kind === "sheet")) return;
    setActiveUnitId((prev) => (prev && units.some((u) => u.unitId === prev) ? prev : units[0].unitId));
  }, [unitsReady, units]);

  // While a draft worktree is being viewed, poll for newly added units — the
  // agent may create Doc/Slide/Base/Board units mid-task via the CLI.
  useEffect(() => {
    if (!selected) return;
    const timer = setInterval(async () => {
      const list = await loadUnits();
      setUnits((prev) =>
        prev.length === list.length && prev.every((p, i) => p.unitId === list[i]?.unitId && p.kind === list[i]?.kind) ? prev : list,
      );
    }, 5000);
    return () => clearInterval(timer);
  }, [selected, loadUnits]);

  // Warm the parsed scope cache for every scope in the background so switching
  // worktrees is instant (first parse per scope takes a moment; unchanged
  // scopes hit the cache — no refetch, no re-parse). Depends on the worktree
  // signature (not the array identity) so it only re-runs when a worktree is
  // added/merged/committed, not on every poll. The route re-validates each
  // scope against its headCommit/mtime, so only changed scopes re-export.
  const warmSignature = `${trunkRev}|${worktrees.map((w) => `${w.id}:${w.status}:${w.headCommit}`).join("|")}`;
  // Warm the xlsx scope exports ONLY for files that actually contain a sheet
  // unit — pure doc/slide files cannot export to xlsx (CLI errors out).
  const hasSheetUnit = units.some((u) => u.kind === "sheet");
  // Pure doc/slide/board file: hide pi-studio's own worktree drawer once the
  // unit list confirms there is no sheet — the gateway viewer's own changes
  // board is the change surface for these files (user decision 2026-08-27:
  // “直接用 CLI 的变更记录看板，不要自定义的”). Hiding it while the unit list
  // is still resolving also avoids a drawer flash before the gateway loads.
  const noSheetFile = unitsReady && units.length > 0 && !hasSheetUnit;
  useEffect(() => {
    if (unitsReady && !hasSheetUnit) return;
    if (worktrees.length === 0) return;
    const scopes = [
      { key: `${filePath}::trunk::${trunkRev}`, url: `/api/univer/view?file=${encodeURIComponent(filePath)}` },
      ...worktrees.map((w) => ({
        key: `${filePath}::wt::${w.id}::${w.headCommit}`,
        url: `/api/univer/view?file=${encodeURIComponent(filePath)}&worktree=${encodeURIComponent(w.id)}`,
      })),
    ];
    const timer = setTimeout(() => {
      for (const s of scopes) void warmScopeData(s.key, s.url);
    }, 600);
    return () => { clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature identity
  }, [filePath, warmSignature]);

  const selectedInfo = worktrees.find((w) => w.id === selected) ?? null;
  const canMerge = selectedInfo !== null && selectedInfo.status !== "merged" && selectedInfo.status !== "discarded";
  const isSelectedDraft = selectedInfo !== null && (selectedInfo.status === "draft" || selectedInfo.status === "active" || selectedInfo.status === "ready");

  // The scope revision the viewer has applied. Frozen on our own auto-saves
  // (ackRevRef), advanced by the poll on external commits, so the grid only
  // re-syncs when the viewed content actually changed.
  const ackRev = selected
    ? (ackRevRef.current[`wt:${selected}`] ?? selectedInfo?.headCommit ?? 0)
    : (ackRevRef.current.trunk ?? trunkRev);
  const scopeKey = selected
    ? `${filePath}::wt::${selected}::${ackRev}`
    : `${filePath}::trunk::${ackRev}`;

  const toggleExpanded = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Sort by last activity ascending (oldest first): merged history at the
  // top, the actively-edited (newest) worktree at the bottom.
  const sortedWorktrees = [...worktrees].sort((a, b) => lastActivity(a) - lastActivity(b));

  // Grouping (user rule 2026-08-08): 编辑中 = the currently-selected editable
  // worktree (only one); 待合并 = every other editable worktree; 已合并 = merged
  // + discarded history. Badges follow the group so a non-selected draft shows
  // 待合并, not 编辑中.
  const isEditable = (w: WorktreeInfo): boolean =>
    w.status === "draft" || w.status === "active" || w.status === "ready";
  const worktreeGroups = [
    {
      key: "editing",
      label: t("files.univerGroupEditing"),
      items: sortedWorktrees.filter((w) => selected === w.id && isEditable(w)),
    },
    {
      key: "pending",
      label: t("files.univerGroupPending"),
      items: sortedWorktrees.filter((w) => selected !== w.id && isEditable(w)),
    },
    {
      key: "done",
      label: t("files.univerGroupMerged"),
      items: sortedWorktrees.filter((w) => w.status === "merged" || w.status === "discarded"),
    },
  ].filter((g) => g.items.length > 0);

  const refreshAll = useCallback(async (): Promise<number> => {
    // Refresh the list + signature WITHOUT bumping refreshKey: the viewer
    // re-syncs via its scopeKey prop whenever the selection changes, and the
    // 5s poll handles external commits. Bumping here reloads the viewer even
    // when the deleted/discarded worktree was not the one being viewed.
    const { worktrees: list, trunkRev: trunkMtime } = await loadWorktrees();
    setWorktrees(list);
    setTrunkRev(trunkMtime);
    signatureRef.current = `${trunkMtime}|${list.map((w) => `${w.id}:${w.status}:${w.headCommit}`).join("|")}`;
    return trunkMtime;
  }, [loadWorktrees]);

  const handleMerge = async (): Promise<void> => {
    if (!selected || !canMerge) return;
    setBusy(true);
    setMsg("");
    try {
      const response = await fetch("/api/univer/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: filePath, worktree: selected }),
      });
      const data = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      setMsg(t("files.univerMerged"));
      // The merge rewrites trunk — advance the trunk revision immediately so
      // switching back to trunk shows the merged content (not a stale cache).
      const newTrunkMtime = await refreshAll();
      ackRevRef.current.trunk = newTrunkMtime;
      prevTrunkRevRef.current = newTrunkMtime;
      setSelected(null);
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async (): Promise<void> => {
    if (!selected) return;
    if (!window.confirm(t("files.univerDiscardConfirm"))) return;
    setBusy(true);
    setMsg("");
    try {
      const response = await fetch("/api/univer/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: filePath, worktree: selected }),
      });
      const data = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      setMsg(t("files.univerDiscarded"));
      setSelected(null);
      await refreshAll();
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteWorktree = async (wtId: string, name: string): Promise<void> => {
    if (!window.confirm(t("files.univerDeleteConfirm", { name }))) return;
    setBusy(true);
    setMsg("");
    try {
      const response = await fetch("/api/univer/worktree-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: filePath, worktree: wtId }),
      });
      const data = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      setMsg(t("files.univerDeleted"));
      if (selected === wtId) setSelected(null);
      await refreshAll();
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const binaryUrl = `/api/univer/view?file=${encodeURIComponent(filePath)}${selected ? `&worktree=${encodeURIComponent(selected)}` : ""}`;

  // ── Multi-unit: resolve the official viewer URL for a non-sheet unit ──
  const activeUnit = activeUnitId ? units.find((u) => u.unitId === activeUnitId) ?? null : null;
  const activeNonSheet = activeUnit !== null && activeUnit.kind !== "sheet" ? activeUnit : null;

  // 导出当前非 sheet 单元（slide→pptx，doc→docx）。The server streams the
  // bytes; we hand them to the browser as a download with a friendly name.
  const handleExportUnit = async (): Promise<void> => {
    if (!activeNonSheet) return;
    const format = activeNonSheet.kind === "slide" ? "pptx" : "docx";
    setExportBusy(true);
    setExportMsg("");
    try {
      const params = new URLSearchParams({ file: filePath, unit: activeNonSheet.unitId, format });
      const res = await fetch(`/api/univer/export?${params.toString()}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const base = (filePath.split("/").pop() ?? "export").replace(/\.univer$/i, "");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${base}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportMsg(`✓ ${t("files.exportUnitDone")}`);
    } catch (error) {
      setExportMsg(`${t("files.exportUnitFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExportBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (!activeUnit || activeUnit.kind === "sheet") {
      setUnitFrame(null);
      return;
    }
    const key = `${filePath}|${selected ?? ""}|${activeUnit.unitId}`;
    const cached = unitUrlCacheRef.current.get(key);
    if (cached) {
      setUnitFrame({ status: "ok", url: cached });
      return;
    }
    setUnitFrame({ status: "loading" });
    const params = new URLSearchParams({ file: filePath });
    if (selected) params.set("worktree", selected);
    params.set("unit", activeUnit.unitId);
    fetch(`/api/univer/open-url?${params.toString()}`)
      .then((r) => r.json() as Promise<{ url?: string; error?: string }>)
      .then((d) => {
        if (cancelled) return;
        if (typeof d.url === "string") {
          unitUrlCacheRef.current.set(key, d.url);
          setUnitFrame({ status: "ok", url: d.url });
        } else {
          setUnitFrame({ status: "error" });
        }
      })
      .catch(() => {
        if (!cancelled) setUnitFrame({ status: "error" });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- primitive identity only
  }, [filePath, selected, activeUnit?.unitId, activeUnit?.kind]);

  const flushRef = useRef<(() => Promise<void>) | null>(null);

  const handleWriteback = async (): Promise<void> => {
    setBusy(true);
    setMsg("");
    try {
      // Flush any pending trunk auto-save edits so 写回原件 reads the latest.
      try { await flushRef.current?.(); } catch { /* best effort */ }
      const response = await fetch("/api/univer/writeback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: filePath, ...(selected ? { worktree: selected } : {}) }),
      });
      const data = await response.json().catch(() => null) as { ok?: boolean; target?: string; error?: string } | null;
      if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      setMsg(`${t("files.univerWritebackDone")}：${data.target ?? ""}`);
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const writebackButton = (
    <button
      type="button"
      onClick={() => void handleWriteback()}
      disabled={busy}
      title={t("files.univerWriteback")}
      style={{ ...toolbarBtnStyle, color: "#2a7aff", borderColor: "#2a7aff" }}
    >
      {t("files.univerWriteback")}
    </button>
  );

  const isSuccessMsg =
    msg.startsWith(t("files.univerMerged").slice(0, 4)) || msg.startsWith(t("files.univerWritebackDone").slice(0, 4));

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", overflow: "hidden" }}>
      {/* ── Left: file/version panel (collapsible) — sheet files only.
          Pure doc/slide/board files hide it entirely: their change records
          live in the gateway viewer's own sidebar (user decision
          2026-08-27), and the chat changed-files card surfaces agent edits. */}
      {!noSheetFile && (panelCollapsed ? (
        <div
          style={{
            width: 30,
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            background: "var(--bg-panel)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            paddingTop: 10,
            gap: 10,
          }}
        >
          <button
            type="button"
            onClick={() => setPanelCollapsed(false)}
            title={t("files.univerExpandPanel")}
            style={panelToggleBtnStyle}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="13 17 18 12 13 7" />
              <polyline points="6 17 11 12 6 7" />
            </svg>
          </button>
          <span
            title={selected ? t("files.univerWorktree") : t("files.univerTrunk")}
            style={{ width: 8, height: 8, borderRadius: 4, background: selected ? "#b7791f" : "#2a7aff", flexShrink: 0 }}
          />
        </div>
      ) : (
      <div
        style={{
          width: 232,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          background: "var(--bg-panel)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          fontSize: 12,
        }}
      >
        {/* Panel header: file name */}
        <div
          style={{
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span style={{ fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {fileName}
          </span>
          <button
            type="button"
            onClick={() => setPanelCollapsed(true)}
            title={t("files.univerCollapsePanel")}
            style={panelToggleBtnStyle}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="11 17 6 12 11 7" />
              <polyline points="18 17 13 12 18 7" />
            </svg>
          </button>
        </div>

        <div style={{ padding: "10px 14px 4px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.6 }}>
          {t("files.univerScopes")}
        </div>

        {/* Trunk */}
        <button
          type="button"
          onClick={() => setSelected(null)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "7px 14px",
            background: selected === null ? "var(--bg-selected)" : "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--text)",
            textAlign: "left",
            fontSize: 12,
          }}
          onMouseEnter={(e) => { if (selected !== null) e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { if (selected !== null) e.currentTarget.style.background = "transparent"; }}
        >
          <span style={{ width: 8, height: 8, borderRadius: 4, background: "#2a7aff", flexShrink: 0 }} />
          <span style={{ fontWeight: 600 }}>{t("files.univerTrunk")}</span>
        </button>

        <div style={{ display: "flex", alignItems: "center", padding: "10px 14px 4px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.6 }}>
          <span style={{ flex: 1 }}>{t("files.univerWorktreesTitle")}</span>
        </div>

        {sortedWorktrees.length === 0 && (
          <div style={{ padding: "12px 14px", color: "var(--text-dim)", fontSize: 11 }}>{t("files.univerNoWorktrees")}</div>
        )}

        {worktreeGroups.map((group) => {
          // Default-expanded: each category is ONE record; its worktrees are
          // listed as sub-items. Click the record header to collapse.
          const groupExpanded = !expandedIds.has(`g:${group.key}`);
          const totalCommits = group.items.reduce((n, w) => n + (w.commits?.length ?? 0), 0);
          const renderRow = (wt: WorktreeInfo) => {
              const badge =
                group.key === "editing"
                  ? { label: t("files.univerBadgeEditing"), bg: "#e6f7ee", color: "#1a7f4b" }
                  : group.key === "pending"
                    ? { label: t("files.univerBadgePending"), bg: "#fff4e0", color: "#b7791f" }
                    : (STATUS_BADGE[wt.status] ?? STATUS_BADGE.merged);
              const active = selected === wt.id;
              const hasCommits = wt.commits.length > 0;
              // Chevron for every worktree with commits — including merged /
              // discarded history, so past records stay inspectable.
              const showChevron = hasCommits;
              const expanded = expandedIds.has(wt.id);
          return (
            <div key={wt.id} style={{ padding: "2px 8px" }}>
              <button
                type="button"
                onClick={() => setSelected(wt.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  padding: "7px 6px",
                  borderRadius: 6,
                  background: active ? "var(--bg-selected)" : "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text)",
                  textAlign: "left",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "1px 6px",
                    borderRadius: "var(--radius-md)",
                    fontSize: 10,
                    fontWeight: 600,
                    background: badge.bg,
                    color: badge.color,
                    flexShrink: 0,
                  }}
                >
                  {badge.label}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, fontWeight: active ? 600 : 400 }}>
                  {wt.name || `${t("files.univerWorktree")} ${wt.id.slice(0, 8)}`}
                </span>
                {(hasCommits || wt.createdAt) && (
                  <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>
                    {formatTime(hasCommits ? wt.commits[wt.commits.length - 1].createdAt : wt.createdAt ?? "")}
                  </span>
                )}
                {group.key === "pending" && hasCommits && (
                  <span
                    style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#b7791f", flexShrink: 0 }}
                    title={t("files.univerPendingCommits")}
                  >
                    r{wt.commits.length}
                  </span>
                )}
                {showChevron ? (
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); toggleExpanded(wt.id); }}
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, flexShrink: 0, cursor: "pointer", color: "var(--text-dim)", borderRadius: 3 }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
                      <polyline points="3 1.5 6.5 5 3 8.5" />
                    </svg>
                  </span>
                ) : (
                  <span style={{ width: 14, flexShrink: 0 }} />
                )}
                {wt.status !== "merged" && (
                  <span
                    role="button"
                    tabIndex={-1}
                    title={t("files.univerDelete")}
                    onClick={(e) => { e.stopPropagation(); void handleDeleteWorktree(wt.id, wt.name || wt.id.slice(0, 8)); }}
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, flexShrink: 0, cursor: "pointer", color: "var(--text-dim)", borderRadius: 3 }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "#d33"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 3h8M4.5 3V2h3v1M3.5 3l.5 7h4l.5-7" />
                    </svg>
                  </span>
                )}
              </button>

              {/* Commit history: collapsible via chevron for every worktree
                  with commits (merged/discarded included). Ascending r1 … rN. */}
              {expanded && hasCommits && (
                <div style={{ padding: "2px 8px 6px 10px", display: "flex", flexDirection: "column", gap: 3 }}>
                  {wt.commits.map((c) => {
                    const isUser = wt.userSeqs?.includes(c.seq) ?? false;
                    return (
                      <div key={c.seq} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-dim)", fontSize: 11 }}>
                        <span
                          title={isUser ? t("files.univerUserEdit") : undefined}
                          style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: isUser ? "#2a7aff" : "var(--text-muted)" }}
                        >
                          {isUser ? "u" : "r"}{c.seq}
                        </span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                          {c.message || (isUser ? t("files.univerUserEdit") : t("files.univerEdit"))}
                        </span>
                        <span style={{ fontSize: 10, flexShrink: 0 }}>{formatTime(c.createdAt)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
            );
          };
          if (group.key === "editing") {
            // 编辑中：当前问答会话的工作区快照，唯一一条（不折叠）
            return <div key={group.key}>{group.items.map(renderRow)}</div>;
          }
          return (
            <div key={group.key}>
              <button
                type="button"
                onClick={() => toggleExpanded(`g:${group.key}`)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  padding: "7px 6px",
                  borderRadius: 6,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text)",
                  textAlign: "left",
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "1px 6px",
                    borderRadius: "var(--radius-md)",
                    fontSize: 10,
                    fontWeight: 600,
                    background: group.key === "pending" ? "#fff4e0" : "#f0f0f0",
                    color: group.key === "pending" ? "#b7791f" : "#666",
                    flexShrink: 0,
                  }}
                >
                  {group.key === "pending" ? t("files.univerBadgePending") : t("files.univerBadgeMerged")}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                  {t(group.key === "pending" ? "files.univerGroupPendingSummary" : "files.univerGroupMergedSummary", {
                    count: String(group.items.length),
                  })}
                </span>
                {group.key === "pending" && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#b7791f", flexShrink: 0 }}>
                    r{totalCommits}
                  </span>
                )}
                <span
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, flexShrink: 0, color: "var(--text-dim)", borderRadius: 3 }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: groupExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
                    <polyline points="3 1.5 6.5 5 3 8.5" />
                  </svg>
                </span>
              </button>
              {groupExpanded && group.items.map(renderRow)}
            </div>
          );
        })}
      </div>
      ))}

      {/* ── Main area ────────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, height: "100%", overflow: "hidden" }}>
        {/* Unit switcher: only rendered once the file actually contains a
            non-sheet unit — pure-sheet files keep the exact old UI. */}
        {units.some((u) => u.kind !== "sheet") && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 12px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-panel)",
              overflowX: "auto",
              flexShrink: 0,
            }}
          >
            {units.map((u) => {
              const isSheetPill = u.kind === "sheet";
              const active = isSheetPill ? activeNonSheet === null : activeUnit?.unitId === u.unitId;
              const color = UNIT_KIND_COLORS[u.kind] ?? "var(--text-muted)";
              return (
                <button
                  key={u.unitId}
                  type="button"
                  onClick={() => setActiveUnitId(isSheetPill ? null : u.unitId)}
                  title={u.name || u.kind}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    border: `1px solid ${active ? color : "var(--border)"}`,
                    borderRadius: 999,
                    padding: "2px 10px",
                    fontSize: 11,
                    background: active ? `color-mix(in srgb, var(--bg-panel), ${color} 8%)` : "transparent",
                    color: "var(--text)",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: 4, background: color, flexShrink: 0 }} />
                  {isSheetPill ? t("files.univerUnitSheet") : t(`files.univerUnit${u.kind.charAt(0).toUpperCase()}${u.kind.slice(1)}`)}
                </button>
              );
            })}
            <span style={{ marginLeft: "auto", flexShrink: 0 }} />
            {activeNonSheet && (activeNonSheet.kind === "slide" || activeNonSheet.kind === "doc") && (
              <>
                {exportMsg && (
                  <span
                    style={{
                      fontSize: 11,
                      color: exportMsg.startsWith("✓") ? "#1a7f4b" : "#d33",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: 260,
                      flexShrink: 0,
                    }}
                    title={exportMsg}
                  >
                    {exportMsg}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void handleExportUnit()}
                  disabled={exportBusy}
                  title={activeNonSheet.kind === "slide" ? t("files.exportUnitSlide") : t("files.exportUnitDoc")}
                  style={{ ...toolbarBtnStyle, color: "#2a7aff", borderColor: "#2a7aff", whiteSpace: "nowrap", flexShrink: 0 }}
                >
                  {exportBusy ? t("files.exportUnitBusy") : activeNonSheet.kind === "slide" ? t("files.exportUnitSlide") : t("files.exportUnitDoc")}
                </button>
              </>
            )}
          </div>
        )}
        {activeNonSheet && (
          // All non-sheet units embed the univer-cli gateway viewer; its own
          // sidebar is the changes board for these files (user decision
          // 2026-08-27). The reload tick remounts the iframe when the trunk
          // is rewritten externally (agent commit / worktree merge) so the
          // merged content shows up without a manual refresh.
          <div style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--bg-panel)" }}>
            {!unitFrame || unitFrame.status === "loading" ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
                {t("files.univerGatewayLoading")}
              </div>
            ) : unitFrame.status === "error" ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#d33", fontSize: 12 }}>
                {t("files.univerGatewayFailed")}
              </div>
            ) : (
              <iframe
                key={`${unitFrame.url}|g${gatewayReloadTick}`}
                src={unitFrame.url}
                title={activeNonSheet.name || activeNonSheet.kind}
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  background: "#fff",
                }}
                allow="clipboard-read; clipboard-write"
              />
            )}
          </div>
        )}
        {/* Unit list still resolving — show a neutral loader instead of the
            grid so pure doc/slide files never flash a doomed xlsx export. */}
        {!unitsReady && !activeNonSheet && (
          <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
            {t("files.unitsLoading")}
          </div>
        )}
        {/* Upper bar: file ops (writeback + exports live in XlsxViewer's header);
            children render as a second row below with the worktree controls.
            XlsxViewer (and its xlsx export) only mounts once the unit list is
            known to contain a sheet — pure doc/slide files render the gateway
            viewer exclusively and must never attempt an xlsx export. */}
        {/* 主干为空：agent 建了工作区但还没合并（或真正的空文件）。绝不落进
            xlsx 分支硬试导出（CLI 报 "Specify --unit"），渲染可恢复面板。 */}
        {unitsReady && units.length === 0 && (
          <EmptyTrunkPanel filePath={filePath} worktrees={worktrees} onMerged={() => { void refreshAll(); }} />
        )}
        {unitsReady && hasSheetUnit && !activeNonSheet && (
        <XlsxViewer
          filePath={filePath}
          sourceSessionId={sourceSessionId}
          binaryUrl={binaryUrl}
          refreshKey={refreshKey}
          scopeKey={scopeKey}
          worktreeId={isSelectedDraft ? selected : null}
          onWorktreeCreated={(id) => {
            // The viewer auto-created a draft worktree (worktree-only editing):
            // select it so subsequent edits + the poll badge reflect it.
            setSelected(id);
            void refreshAll();
          }}
          flushRef={flushRef}
          ownSaveRef={ownSaveRef}
          headerExtra={writebackButton}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              background: "var(--bg-hover)",
              borderRadius: "var(--radius-md)",
              padding: "1px 8px",
              flexShrink: 0,
            }}
          >
            {selected ? `${badgeLabel(selectedInfo)} · ${selectedInfo && selectedInfo.userSeqs?.includes(selectedInfo.headCommit) ? "u" : "r"}${selectedInfo?.headCommit}` : "trunk"}
          </span>

          {msg && (
            <span style={{ fontSize: 11, color: isSuccessMsg ? "#1a7f4b" : "#d33", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
              {msg}
            </span>
          )}

          <span style={{ marginLeft: "auto" }} />

          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            title={t("files.univerRefresh")}
            style={toolbarBtnStyle}
          >
            {t("files.univerRefresh")}
          </button>
          <button
            type="button"
            onClick={() => void handleDiscard()}
            disabled={!isSelectedDraft || busy}
            style={{
              ...toolbarBtnStyle,
              color: "#d33",
              borderColor: isSelectedDraft ? "#d33" : "var(--border)",
              cursor: isSelectedDraft && !busy ? "pointer" : "not-allowed",
              opacity: isSelectedDraft ? 1 : 0.4,
            }}
          >
            {t("files.univerDiscard")}
          </button>
          <button
            type="button"
            onClick={() => void handleMerge()}
            disabled={!canMerge || busy}
            style={{
              background: "#2a7aff",
              border: "1px solid #2a7aff",
              borderRadius: 5,
              padding: "3px 14px",
              fontSize: 12,
              fontWeight: 600,
              color: "#fff",
              cursor: canMerge && !busy ? "pointer" : "not-allowed",
              opacity: canMerge ? 1 : 0.4,
            }}
          >
            {busy ? t("files.univerMerging") : t("files.univerMerge")}
          </button>
        </XlsxViewer>
        )}

        {/* Status bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "3px 12px",
            borderTop: "1px solid var(--border)",
            fontSize: 11,
            color: "var(--text-dim)",
            background: "var(--bg-panel)",
            flexShrink: 0,
          }}
        >
          <span>{t("files.univerAutoRefresh")}</span>
          <span style={{ marginLeft: "auto" }}>
            {selected ? `${t("files.univerWorktree")}: ${selected.slice(0, 16)}` : t("files.univerTrunk")}
          </span>
        </div>
      </div>
    </div>
  );
}

function badgeLabel(info: WorktreeInfo | null): string {
  if (!info) return "trunk";
  return STATUS_BADGE[info.status]?.label ?? info.status;
}

function lastActivity(w: WorktreeInfo): number {
  if (w.commits.length > 0) {
    const last = w.commits[w.commits.length - 1];
    const t = new Date(last.createdAt).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const t = new Date(w.createdAt ?? "").getTime();
  if (!Number.isNaN(t)) return t;
  return 0;
}

/**
 * 主干为空时的恢复面板：agent 建了工作区但回合中断没合并（2026-08-28 打包版
 * 实测，CLI 报 "Specify --unit: zero or multiple units" 的根源）。给用户一键
 * 「合并最新工作区」（显式操作，不违反不自动合并铁律）+ 重新检测。
 */
function EmptyTrunkPanel({ filePath, worktrees, onMerged }: {
  filePath: string;
  worktrees: WorktreeInfo[];
  onMerged: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // agent 按铁律只 mark ready（不合并）：draft/active/ready 都视为「待用户合并」
  const draft = [...worktrees].reverse().find((w) => w.status === "draft" || w.status === "active" || w.status === "ready");

  const mergeDraft = async (): Promise<void> => {
    if (!draft || busy) return;
    setBusy(true);
    setMsg("");
    try {
      const response = await fetch("/api/univer/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: filePath, worktree: draft.id }),
      });
      const data = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      setMsg(t("files.univerMerged"));
      await onMerged();
    } catch (error) {
      setMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 460, display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("files.emptyTrunkTitle")}</div>
        <div style={{ fontSize: 12, lineHeight: 1.7, color: "var(--text-dim)", wordBreak: "break-word" }}>
          {draft
            ? t("files.emptyTrunkHint", { worktree: draft.id, commits: String(draft.headCommit) })
            : t("files.emptyTrunkNone")}
        </div>
        {msg && (
          <div style={{ fontSize: 12, color: msg.startsWith(t("files.univerMerged")) ? "#1a7f4b" : "#d33", wordBreak: "break-word" }}>
            {msg}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          {draft && (
            <button
              type="button"
              onClick={() => void mergeDraft()}
              disabled={busy}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "6px 14px",
                background: busy ? "var(--bg-hover)" : "var(--accent-soft)",
                border: "1px solid var(--accent)",
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 600,
                color: busy ? "var(--text-dim)" : "var(--accent-hover)",
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? t("i18n.loading") : t("files.emptyTrunkMerge")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void onMerged()}
            style={{
              display: "inline-flex", alignItems: "center",
              padding: "6px 14px",
              background: "none",
              border: "1px solid var(--border)",
              borderRadius: 7,
              fontSize: 12,
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            {t("files.univerRefresh")}
          </button>
        </div>
      </div>
    </div>
  );
}

const toolbarBtnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: 5,
  padding: "3px 10px",
  fontSize: 11,
  color: "var(--text)",
  cursor: "pointer",
  flexShrink: 0,
};

const panelToggleBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  color: "var(--text-muted)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 4,
  borderRadius: 4,
  flexShrink: 0,
};
