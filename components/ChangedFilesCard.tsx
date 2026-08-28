"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangedFile } from "@/lib/changed-files";
import { getFileName, getRelativeFilePath, joinFilePath, resolveFilePath } from "@/lib/file-paths";
import { parseUnifiedPatch } from "@/lib/patch";
import { useI18n } from "@/hooks/useI18n";

// Electron 桥（preload.cjs contextBridge）：revealFile 走主进程原生
// shell.showItemInFolder，资源管理器窗口才能可靠置前；浏览器模式下不存在。
interface PiElectronRevealApi {
  revealFile?: (filePath: string) => Promise<{ ok: boolean; error?: string; filePath?: string }>;
}

function getNativeReveal(): PiElectronRevealApi["revealFile"] | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { piElectron?: PiElectronRevealApi }).piElectron?.revealFile;
}

const MAX_COLLAPSED = 8;

const KIND_COLORS: Record<ChangedFile["kind"], string> = {
  edit: "#d6a84b",   // matches FileExplorer "modified"
  write: "#4ade80",  // matches FileExplorer "added"
};

const KIND_LABEL: Record<ChangedFile["kind"], string> = {
  edit: "M",
  write: "A",
};

type ActionKey = "reveal" | "external";

interface DiffStatEntry {
  added: number;
  removed: number;
  exists: boolean;
}

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith("/") || /^[a-zA-Z]:[\/]/.test(filePath);
}

function getExt(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function countDiffStats(patch: string): { added: number; removed: number } {
  const files = parseUnifiedPatch(patch);
  if (!files) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const file of files) {
    for (const row of file.rows) {
      if (row.type !== "line") continue;
      if (row.right.type === "added") added += 1;
      if (row.left.type === "removed") removed += 1;
    }
  }
  return { added, removed };
}

async function fetchDiffStats(
  cacheKey: string,
  cwd: string,
  absPath: string,
): Promise<DiffStatEntry | null> {
  try {
    const params = new URLSearchParams({ cwd, path: absPath });
    const response = await fetch(`/api/git/diff?${params.toString()}`);
    const data = await response.json() as { supported?: boolean; patch?: string; exists?: boolean };
    // `exists` defaults to true on transport/API errors so a transient failure
    // never hides a real file. Only an explicit `exists: false` (the file was
    // written and later deleted — a scratch script) removes the row.
    const exists = data?.exists !== false;
    if (data?.supported && typeof data.patch === "string") {
      return { ...countDiffStats(data.patch), exists };
    }
    return { added: 0, removed: 0, exists };
  } catch {
    // No git repo or transient failure — row simply shows no stats.
  } finally {
    // Keep failed entries cached too so a repeated render doesn't retry
    // immediately; the TTL below bounds staleness.
    setTimeout(() => diffStatsCache.delete(cacheKey), 60_000);
  }
  return null;
}

interface Props {
  files: ChangedFile[];
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

const DIFF_STATS_FETCH_DELAY_MS = 250;
const DIFF_STATS_MAX_CONCURRENCY = 3;

// Module-level cache: the same file often appears in several cards across a
// session; each diff is expensive (spawns git), so fetch once per (cwd, path).
const diffStatsCache = new Map<string, Promise<DiffStatEntry | null>>();

/**
 * Compact card shown under an assistant message listing the files the turn
 * edited/wrote — the single unified file card. Each row opens the file in the
 * right-hand viewer (diff mode for tracked changes; plain view for generated
 * deliverables without git history) and offers reveal-in-folder /
 * open-external actions. Files the agent wrote and then deleted (scratch
 * scripts) are hidden once the server confirms they are gone.
 */
export function ChangedFilesCard({ files, cwd, onOpenFile }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [stats, setStats] = useState<Record<string, { added: number; removed: number }>>({});
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<Record<string, { action: ActionKey; ok: boolean }>>({});
  const [actionError, setActionError] = useState<{ filePath: string; message: string } | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToggle = files.length > MAX_COLLAPSED;
  const visible = (showToggle && !expanded ? files.slice(0, MAX_COLLAPSED) : files)
    .filter((file) => !missing.has(file.filePath));

  // Stable key so the fetch below only re-runs when the file set actually
  // changes (the `files` prop reference changes on every parent render).
  const filesKey = files.map((f) => `${f.kind}:${f.filePath}`).join("\u0000");

  // Lazily fetch per-file git diff stats (+N / -M) and existence for display.
  // Fetching is delayed (first paint wins), concurrency-capped, and memoised
  // per (cwd, path) so repeated cards for the same file cost one request.
  useEffect(() => {
    let cancelled = false;
    setStats({});
    setMissing(new Set());
    if (!cwd) return;

    const entries = files.map((file) => ({
      file,
      absPath: isAbsolutePath(file.filePath) ? file.filePath : joinFilePath(cwd, file.filePath),
      cacheKey: `${cwd}\u0000${file.filePath}`,
    }));

    (async () => {
      await new Promise((resolve) => setTimeout(resolve, DIFF_STATS_FETCH_DELAY_MS));
      if (cancelled) return;

      const results: Record<string, { added: number; removed: number }> = {};
      const missingSet = new Set<string>();
      let next = 0;
      const worker = async (): Promise<void> => {
        while (!cancelled) {
          const entry = entries[next++];
          if (!entry) return;
          const cached = diffStatsCache.get(entry.cacheKey);
          const promise = cached ?? fetchDiffStats(entry.cacheKey, cwd, entry.absPath);
          if (!diffStatsCache.has(entry.cacheKey)) diffStatsCache.set(entry.cacheKey, promise);
          const value = await promise;
          if (cancelled || !value) continue;
          if (!value.exists) {
            missingSet.add(entry.file.filePath);
            // Don't memoize "missing": a file that appears gone during
            // streaming may just be mid-write. Re-check on the next card
            // mount (the completed turn) so it can reappear.
            diffStatsCache.delete(entry.cacheKey);
          } else if (value.added > 0 || value.removed > 0) {
            results[entry.file.filePath] = { added: value.added, removed: value.removed };
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DIFF_STATS_MAX_CONCURRENCY, entries.length) }, worker),
      );
      if (!cancelled) {
        setStats(results);
        setMissing(missingSet);
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, filesKey]);

  useEffect(() => () => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
  }, []);

  const runAction = async (filePath: string, action: ActionKey) => {
    const resolved = resolveFilePath(filePath, cwd);
    setFeedback((prev) => ({ ...prev, [filePath]: { action, ok: true } }));
    let ok = false;
    let message = "";
    let nativeHandled = false;
    if (action === "reveal") {
      const nativeReveal = getNativeReveal();
      if (nativeReveal) {
        // Electron：主进程 shell.showItemInFolder（原生置前，绕过后台进程前台锁）。
        // 原生成功则跳过 HTTP；原生失败仍回退服务端路由再试一次。
        nativeHandled = true;
        try {
          const res = await nativeReveal(resolved);
          ok = Boolean(res?.ok);
          if (!ok) message = res?.error || "Could not open Explorer";
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
      }
    }
    if (nativeHandled && ok) return;
    const endpoint = action === "reveal" ? "/api/files/reveal" : "/api/files/open-external";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: resolved }),
      });
      ok = response.ok;
      if (!ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        message = data.error ?? `HTTP ${response.status}`;
      }
    } catch {
      message = "Network error";
    }
    setFeedback((prev) => ({ ...prev, [filePath]: { action, ok } }));
    if (ok) {
      setActionError(null);
    } else {
      setActionError({ filePath, message });
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setActionError(null), 8000);
    }
    window.setTimeout(() => {
      setFeedback((prev) => {
        const next = { ...prev };
        delete next[filePath];
        return next;
      });
    }, 1600);
  };

  return (
    <div
      style={{
        borderRadius: 7,
        overflow: "hidden",
        fontSize: 12,
        border: "1px solid var(--border)",
        background: "var(--bg-panel)",
        marginTop: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 10px",
          color: "var(--text-muted)",
          fontSize: 12,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="m9 13 6 0" />
          <path d="m9 17 6 0" />
        </svg>
        <span>{t("files.changedFiles", { count: files.length })}</span>
        <span style={{ marginLeft: "auto" }} />
        {showToggle && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11,
              padding: 0,
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {expanded ? t("files.hideChanged") : t("files.showAllChanged")}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        )}
      </div>

      {actionError && (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            fontSize: 11,
            lineHeight: 1.4,
            color: "#f87171",
            borderTop: "1px solid var(--border)",
            background: "color-mix(in srgb, #ef4444 7%, var(--bg-panel))",
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5" />
            <path d="M12 17h.01" />
          </svg>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={actionError.filePath}>
            {getFileName(actionError.filePath)}: {actionError.message}
          </span>
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--border)" }}>
        {visible.map((file) => {
          const rowFeedback = feedback[file.filePath];
          const fileStats = stats[file.filePath];
          const showStats = fileStats && (fileStats.added > 0 || fileStats.removed > 0);
          return (
            <div
              key={file.filePath}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                width: "100%",
                padding: "2px 10px",
                color: "var(--text)",
                fontSize: 12,
              }}
            >
              <button
                type="button"
                title={t("files.openInViewer")}
                aria-label={t("files.openInViewer")}
                onClick={() => onOpenFile?.(resolveFilePath(file.filePath, cwd))}
                disabled={!onOpenFile}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flex: 1,
                  minWidth: 0,
                  padding: "2px 0",
                  background: "none",
                  border: "none",
                  cursor: onOpenFile ? "pointer" : "default",
                  color: "var(--text)",
                  fontSize: 12,
                  textAlign: "left",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              >
                <span
                  title={file.kind === "edit" ? t("files.modified") : t("files.added")}
                  style={{
                    width: 16,
                    height: 16,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 3,
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: "var(--font-mono)",
                    color: KIND_COLORS[file.kind],
                    background: `${KIND_COLORS[file.kind]}1a`,
                    border: `1px solid ${KIND_COLORS[file.kind]}40`,
                  }}
                >
                  {KIND_LABEL[file.kind]}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
                    color: "var(--text)",
                  }}
                >
                  {getRelativeFilePath(file.filePath, cwd)}
                </span>
                {showStats && (
                  <span
                    style={{
                      flexShrink: 0,
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      fontVariantNumeric: "tabular-nums",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fileStats.added > 0 && (
                      <span style={{ color: "#4ade80" }}>+{fileStats.added}</span>
                    )}
                    {fileStats.removed > 0 && (
                      <span style={{ color: "#f87171" }}>{fileStats.added > 0 ? " " : ""}-{fileStats.removed}</span>
                    )}
                  </span>
                )}
              </button>

              {getExt(file.filePath) && (
                <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", letterSpacing: "0.02em" }}>
                  {getExt(file.filePath)}
                </span>
              )}

              <span style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                <button
                  type="button"
                  title={t("files.revealInFolder")}
                  aria-label={t("files.revealInFolder")}
                  onClick={() => void runAction(file.filePath, "reveal")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 24, height: 24, padding: 0,
                    background: "none", border: "none", borderRadius: 4,
                    color: rowFeedback?.action === "reveal" ? (rowFeedback.ok ? "#4ade80" : "#f87171") : "var(--text-muted)",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                >
                  {rowFeedback?.action === "reveal" ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1Z" /></svg>
                  )}
                </button>
                <button
                  type="button"
                  title={t("files.openExternal")}
                  aria-label={t("files.openExternal")}
                  onClick={() => void runAction(file.filePath, "external")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 24, height: 24, padding: 0,
                    background: "none", border: "none", borderRadius: 4,
                    color: rowFeedback?.action === "external" ? (rowFeedback.ok ? "#4ade80" : "#f87171") : "var(--text-muted)",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                >
                  {rowFeedback?.action === "external" ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                  )}
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
