"use client";

import { useEffect, useState } from "react";
import type { ChangedFile } from "@/lib/changed-files";
import { getRelativeFilePath, joinFilePath } from "@/lib/file-paths";
import { parseUnifiedPatch } from "@/lib/patch";
import { useI18n } from "@/hooks/useI18n";

const MAX_COLLAPSED = 8;

const KIND_COLORS: Record<ChangedFile["kind"], string> = {
  edit: "#d6a84b",   // matches FileExplorer "modified"
  write: "#4ade80",  // matches FileExplorer "added"
};

const KIND_LABEL: Record<ChangedFile["kind"], string> = {
  edit: "M",
  write: "A",
};

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith("/") || /^[a-zA-Z]:[\/]/.test(filePath);
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
): Promise<{ added: number; removed: number } | null> {
  try {
    const params = new URLSearchParams({ cwd, path: absPath });
    const response = await fetch(`/api/git/diff?${params.toString()}`);
    const data = await response.json() as { supported?: boolean; patch?: string };
    if (data?.supported && typeof data.patch === "string") {
      return countDiffStats(data.patch);
    }
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
const diffStatsCache = new Map<string, Promise<{ added: number; removed: number } | null>>();

/**
 * Compact card shown under an assistant message listing the files the turn
 * edited/wrote. Each row opens the file in the right-hand viewer in diff mode
 * (the same git diff view used by the explorer's Changes list).
 */
export function ChangedFilesCard({ files, cwd, onOpenFile }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [stats, setStats] = useState<Record<string, { added: number; removed: number }>>({});
  const showToggle = files.length > MAX_COLLAPSED;
  const visible = showToggle && !expanded ? files.slice(0, MAX_COLLAPSED) : files;

  // Stable key so the fetch below only re-runs when the file set actually
  // changes (the `files` prop reference changes on every parent render).
  const filesKey = files.map((f) => `${f.kind}:${f.filePath}`).join("\u0000");

  // Lazily fetch per-file git diff stats (+N / -M) for display on each row.
  // Fetching is delayed (first paint wins), concurrency-capped, and memoised
  // per (cwd, path) so repeated cards for the same file cost one request.
  useEffect(() => {
    let cancelled = false;
    setStats({});
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
      let next = 0;
      const worker = async (): Promise<void> => {
        while (!cancelled) {
          const entry = entries[next++];
          if (!entry) return;
          const cached = diffStatsCache.get(entry.cacheKey);
          const stats = cached ?? fetchDiffStats(entry.cacheKey, cwd, entry.absPath);
          if (!diffStatsCache.has(entry.cacheKey)) diffStatsCache.set(entry.cacheKey, stats);
          const value = await stats;
          if (!cancelled && value) results[entry.file.filePath] = value;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DIFF_STATS_MAX_CONCURRENCY, entries.length) }, worker),
      );
      if (!cancelled) setStats(results);
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, filesKey]);

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

      <div style={{ borderTop: "1px solid var(--border)" }}>
        {visible.map((file) => (
          <button
            key={file.filePath}
            type="button"
            title={t("files.openInViewer")}
            aria-label={t("files.openInViewer")}
            onClick={() => onOpenFile?.(file.filePath)}
            disabled={!onOpenFile}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "4px 10px",
              background: "none",
              border: "none",
              cursor: onOpenFile ? "pointer" : "default",
              color: "var(--text)",
              fontSize: 12,
              textAlign: "left",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
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
            {(() => {
              const fileStats = stats[file.filePath];
              if (!fileStats || (fileStats.added === 0 && fileStats.removed === 0)) return null;
              return (
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
              );
            })()}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
