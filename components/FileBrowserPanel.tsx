"use client";

import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { getFileName, joinFilePath } from "@/lib/file-paths";

interface Props {
  cwd: string | null;
  onOpenFile: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
}

function ToolbarIconButton({
  onClick,
  title,
  disabled,
  skipHover,
  color,
  background = "none",
  marginRight,
  ariaPressed,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  skipHover?: boolean;
  color: string;
  background?: string;
  marginRight?: number;
  ariaPressed?: boolean;
  children: ReactNode;
}) {
  const enter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = "var(--text-muted)";
    e.currentTarget.style.background = "var(--bg-hover)";
  };
  const leave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = color;
    e.currentTarget.style.background = background;
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, marginRight,
        background,
        border: "none", borderRadius: "var(--radius-xs)",
        color,
        cursor: disabled ? "default" : "pointer",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {children}
    </button>
  );
}

export function FileBrowserPanel({ cwd, onOpenFile, onAtMention, onAtMentions, explorerRefreshKey, onExplorerRefresh }: Props) {
  const { t } = useI18n();
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [fileSearchResults, setFileSearchResults] = useState<Array<{ path: string; isDir: boolean }>>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchActiveIdx, setFileSearchActiveIdx] = useState(-1);
  const fileSearchAbortRef = useRef<AbortController | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => () => {
    if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
    if (fileSearchAbortRef.current) fileSearchAbortRef.current.abort();
  }, []);

  // File search: debounced fuzzy match against /api/file-index for the cwd
  // (same endpoint the chat @ menu uses).
  useEffect(() => {
    if (!fileSearchOpen) {
      setFileSearchResults([]);
      setFileSearchLoading(false);
      return;
    }
    const q = fileSearchQuery.trim();
    if (!cwd || !q) {
      setFileSearchResults([]);
      setFileSearchLoading(false);
      return;
    }
    setFileSearchLoading(true);
    const timer = setTimeout(() => {
      const controller = new AbortController();
      fileSearchAbortRef.current?.abort();
      fileSearchAbortRef.current = controller;
      void fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (controller.signal.aborted) return;
          setFileSearchResults((data?.matches ?? []) as Array<{ path: string; isDir: boolean }>);
        })
        .catch(() => { if (!controller.signal.aborted) setFileSearchResults([]); })
        .finally(() => { if (!controller.signal.aborted) setFileSearchLoading(false); });
    }, 180);
    return () => clearTimeout(timer);
  }, [fileSearchOpen, fileSearchQuery, cwd]);

  // Open a file-search result: files open in the right panel; directories
  // reveal (expand) in the tree and exit search mode.
  const openSearchedResult = useCallback((r: { path: string; isDir: boolean }) => {
    if (!cwd) return;
    const abs = joinFilePath(cwd, r.path);
    if (r.isDir) {
      fileExplorerRef.current?.revealPath(abs);
      setFileSearchOpen(false);
      setFileSearchQuery("");
      setFileSearchActiveIdx(-1);
    } else {
      onOpenFile?.(abs, getFileName(abs));
    }
  }, [cwd, onOpenFile]);

  const cwdName = cwd ? getFileName(cwd) || cwd : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "16px 12px 10px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, color: "var(--text-muted)", fontSize: 13, fontWeight: 450 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {cwdName ?? t("sidebar.selectProject")}
          </span>
        </div>
      </div>

      {/* Toolbar: search + refresh + changed files */}
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 12px 6px" }}>
        {changesCount > 0 && (
          <ToolbarIconButton
            onClick={() => setChangesCollapsed((v) => !v)}
            title={t("sidebar.changedFiles", { count: changesCount })}
            ariaPressed={!changesCollapsed}
            color={changesCollapsed ? "var(--text-dim)" : "var(--accent)"}
            background={changesCollapsed ? "none" : "var(--bg-selected)"}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </ToolbarIconButton>
        )}
        <ToolbarIconButton
          onClick={() => {
            if (fileSearchOpen) setFileSearchQuery("");
            setFileSearchOpen((v) => !v);
          }}
          ariaPressed={fileSearchOpen}
          title={t("activity.searchFiles")}
          color={fileSearchOpen ? "var(--accent)" : "var(--text-dim)"}
          background={fileSearchOpen ? "var(--bg-selected)" : "none"}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </ToolbarIconButton>
        <ToolbarIconButton
          onClick={() => {
            if (onExplorerRefresh) onExplorerRefresh();
            else setExplorerKey((k) => k + 1);
            setExplorerRefreshDone(true);
            if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
            explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
          }}
          title={t("sidebar.refreshExplorer")}
          skipHover={explorerRefreshDone}
          color={explorerRefreshDone ? "#4ade80" : "var(--text-dim)"}
          background={explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none"}
          marginRight={6}
        >
          {explorerRefreshDone ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          )}
        </ToolbarIconButton>
      </div>

      {fileSearchOpen && (
        <div style={{ position: "relative", display: "flex", alignItems: "center", flexShrink: 0, padding: "0 12px 6px" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", left: 21, pointerEvents: "none" }}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={fileSearchQuery}
            onChange={(e) => { setFileSearchQuery(e.target.value); setFileSearchActiveIdx(-1); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setFileSearchQuery(""); setFileSearchOpen(false); return; }
              if (e.key === "Enter") {
                e.preventDefault();
                const target = fileSearchResults[fileSearchActiveIdx >= 0 ? fileSearchActiveIdx : 0];
                if (target) openSearchedResult(target);
                return;
              }
              if (e.key === "ArrowDown") { e.preventDefault(); setFileSearchActiveIdx((i) => Math.min(fileSearchResults.length - 1, (i < 0 ? -1 : i) + 1)); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setFileSearchActiveIdx((i) => Math.max(-1, (i < 0 ? 0 : i) - 1)); return; }
            }}
            placeholder={t("activity.searchFiles")}
            autoFocus
            style={{
              width: "100%", boxSizing: "border-box", fontSize: 12, fontFamily: "inherit",
              padding: "7px 28px 7px 26px",
              border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)",
              outline: "none", background: "var(--bg)", color: "var(--text)",
            }}
          />
          {fileSearchQuery && (
            <button
              type="button"
              onClick={() => setFileSearchQuery("")}
              title={t("i18n.clearAll")}
              style={{ position: "absolute", right: 14, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-xs)", color: "var(--text-dim)", cursor: "pointer" }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          )}
        </div>
      )}

      {/* Body */}
      {cwd ? (
        <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
          <FileExplorer
            ref={fileExplorerRef}
            cwd={cwd}
            onOpenFile={onOpenFile ?? (() => {})}
            refreshKey={explorerKey}
            onAtMention={onAtMention}
            onAtMentions={onAtMentions}
            onUploadBusyChange={() => {}}
            changesCollapsed={changesCollapsed}
            onChangesCountChange={setChangesCount}
          />
          {fileSearchOpen && fileSearchQuery.trim() && (
            <div style={{ position: "absolute", inset: 0, overflowY: "auto", overflowX: "hidden", background: "var(--bg-panel)", zIndex: 5, padding: "0 8px 8px" }}>
              {fileSearchLoading && (
                <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>{t("sidebar.loading")}</div>
              )}
              {!fileSearchLoading && fileSearchResults.length === 0 && (
                <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>{t("i18n.noResults")}</div>
              )}
              {fileSearchResults.map((r, i) => (
                <button
                  key={r.path}
                  type="button"
                  onClick={() => openSearchedResult(r)}
                  onMouseEnter={() => setFileSearchActiveIdx(i)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    width: "100%", padding: "7px 10px",
                    background: fileSearchActiveIdx === i ? "var(--bg-selected)" : "transparent",
                    border: "none", borderRadius: "var(--radius-xs)",
                    color: "var(--text)", cursor: "pointer", textAlign: "left",
                    fontSize: 12, fontFamily: "var(--font-mono)",
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    {r.isDir ? <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /> : <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>}
                  </svg>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.path}</span>
                  {r.isDir && <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>dir</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "24px 16px", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
          {t("sidebar.selectProject")}
        </div>
      )}
    </div>
  );
}
