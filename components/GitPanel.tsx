"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { GitStatusResponse, GitFileStatus } from "@/lib/git-types";

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface Props {
  cwd: string | null;
  onCwdChange: (cwd: string, projectRoot?: string | null) => void;
}

const STATUS_COLORS: Record<GitFileStatus["code"], string> = {
  M: "#d6a84b",
  A: "#4ade80",
  D: "#f87171",
  R: "#0891b2",
  U: "#a78bfa",
  C: "#f87171",
};

export function GitPanel({ cwd, onCwdChange }: Props) {
  const { t } = useI18n();
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [isGit, setIsGit] = useState(false);
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    if (!cwd) return;
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const [wtRes, stRes] = await Promise.all([
        fetch(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`),
        fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`),
      ]);
      if (id !== reqRef.current) return;
      const wt = (await wtRes.json().catch(() => ({}))) as {
        projectRoot?: string;
        isGit?: boolean;
        worktrees?: WorktreeEntry[];
        error?: string;
      };
      const st = (await stRes.json().catch(() => null)) as GitStatusResponse | null;
      if (id !== reqRef.current) return;
      setProjectRoot(wt.projectRoot ?? cwd);
      setIsGit(Boolean(wt.isGit));
      setWorktrees(wt.worktrees ?? []);
      setStatus(st);
      if (wt.error && !wt.worktrees) setError(wt.error);
    } catch (e) {
      if (id !== reqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleWorktrees = filter.trim()
    ? worktrees.filter((w) => (w.branch ?? w.path).toLowerCase().includes(filter.trim().toLowerCase()))
    : worktrees;

  const files = status?.files ?? [];
  const visibleFiles = filter.trim()
    ? files.filter((f) => f.filePath.toLowerCase().includes(filter.trim().toLowerCase()))
    : files;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "14px 12px 8px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }}>
            {t("activity.git")}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            title={t("i18n.refresh")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              background: "var(--bg-hover)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </div>
      </div>

      <div style={{ padding: "0 12px 8px", flexShrink: 0 }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("sidebar.filterProjects")}
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontSize: 12,
            fontFamily: "inherit",
            padding: "6px 9px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
        {!cwd && (
          <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("workspace.selectProject")}
          </div>
        )}
        {cwd && loading && <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>{t("sidebar.loading")}</div>}
        {error && <div style={{ padding: "12px 10px", color: "#f87171", fontSize: 12 }}>{error}</div>}

        {cwd && !loading && !isGit && (
          <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("activity.notGit")}
          </div>
        )}

        {cwd && isGit && (
          <>
            <SectionHeader label={t("activity.worktrees")} count={worktrees.length} />
            {visibleWorktrees.map((wt) => {
              const isCurrent = wt.path === cwd || (wt.isMain && !worktrees.some((w) => w.path === cwd));
              return (
                <button
                  key={wt.path}
                  type="button"
                  onClick={() => {
                    setProjectRoot((p) => p);
                    onCwdChange(wt.path, projectRoot ?? wt.path);
                  }}
                  title={wt.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "7px 10px",
                    background: isCurrent ? "var(--bg-selected)" : "transparent",
                    border: "none",
                    borderLeft: isCurrent ? "2px solid var(--accent)" : "2px solid transparent",
                    borderRadius: 6,
                    color: isCurrent ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    if (!isCurrent) e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isCurrent) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isCurrent && !wt.isMain ? "var(--accent)" : "var(--text-dim)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {wt.branch ?? wt.path}
                  </span>
                  {wt.isMain && <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>{t("sidebar.main")}</span>}
                </button>
              );
            })}

            <SectionHeader
              label={t("activity.changes")}
              count={files.length}
              trailing={
                files.length > 0 ? (
                  <span style={{ color: "var(--text-dim)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                    +{status?.additions ?? 0} −{status?.deletions ?? 0}
                  </span>
                ) : null
              }
            />
            {visibleFiles.length === 0 && (
              <div style={{ padding: "8px 10px", color: "var(--text-dim)", fontSize: 12 }}>
                {filter.trim() ? t("i18n.noResults") : t("activity.clean")}
              </div>
            )}
            {visibleFiles.map((f) => (
              <div
                key={f.filePath}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 10px",
                  color: "var(--text-muted)",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                }}
                title={f.filePath}
              >
                <span
                  style={{
                    flexShrink: 0,
                    width: 14,
                    textAlign: "center",
                    fontWeight: 700,
                    fontSize: 11,
                    color: STATUS_COLORS[f.code] ?? "var(--text-muted)",
                  }}
                >
                  {f.code}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.filePath}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SectionHeader({ label, count, trailing }: { label: string; count: number; trailing?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 6px 4px" }}>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-dim)" }}>
        {label}
      </span>
      <span style={{ fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{count}</span>
      {trailing && <span style={{ marginLeft: "auto" }}>{trailing}</span>}
    </div>
  );
}
