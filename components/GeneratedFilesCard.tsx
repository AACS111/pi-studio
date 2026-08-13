"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangedFile } from "@/lib/changed-files";
import { getFileName, getRelativeFilePath, resolveFilePath } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";

const MAX_COLLAPSED = 8;

const DIM = "var(--text-dim)";

function getExt(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Small flat type icon for generated deliverables. */
function GeneratedFileTypeIcon({ filePath, size = 15 }: { filePath: string; size?: number }) {
  const ext = getExt(filePath);
  const isSpreadsheet = ["xlsx", "xls", "univer", "csv", "tsv"].includes(ext);
  const isDoc = ["docx", "doc", "md", "txt", "html", "htm", "json"].includes(ext);
  const isSlide = ["pptx", "ppt"].includes(ext);
  const isPdf = ext === "pdf";
  const isImage = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].includes(ext);
  const isArchive = ["zip", "rar", "7z", "tar", "gz"].includes(ext);

  if (isSpreadsheet) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <rect x="2" y="1.5" width="12" height="13" rx="1.2" stroke={DIM} strokeWidth="1" fill={DIM} fillOpacity="0.08" />
        <path d="M2 5.5h12M5.5 5.5v9M8.5 5.5v9M11.5 5.5v9" stroke={DIM} strokeWidth="0.8" />
      </svg>
    );
  }
  if (isSlide) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <rect x="2" y="2" width="12" height="9.5" rx="1.2" stroke={DIM} strokeWidth="1" fill={DIM} fillOpacity="0.08" />
        <path d="M5.5 14.5h5M8 11.5v3" stroke={DIM} strokeWidth="1" />
      </svg>
    );
  }
  if (isPdf) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <path d="M3 1.5h7l3 3v10H3V1.5Z" stroke={DIM} strokeWidth="1" fill={DIM} fillOpacity="0.08" strokeLinejoin="round" />
        <path d="M10 1.5v3h3" stroke={DIM} strokeWidth="1" fill="none" strokeLinejoin="round" />
        <text x="8" y="12" textAnchor="middle" fontSize="3.6" fontFamily="var(--font-mono), monospace" fontWeight="700" fill={DIM}>PDF</text>
      </svg>
    );
  }
  if (isImage) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <rect x="2" y="2.5" width="12" height="11" rx="1.2" stroke={DIM} strokeWidth="1" fill={DIM} fillOpacity="0.08" />
        <circle cx="5.5" cy="6" r="1.1" stroke={DIM} strokeWidth="0.9" />
        <path d="m3.5 12.5 3.2-3.2 2.2 2.2 1.6-1.6 2 2.6" stroke={DIM} strokeWidth="0.9" fill="none" strokeLinejoin="round" />
      </svg>
    );
  }
  if (isArchive) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
        <rect x="2.5" y="1.5" width="11" height="13" rx="1.2" stroke={DIM} strokeWidth="1" fill={DIM} fillOpacity="0.08" />
        <path d="M5.5 4.5h5M5.5 7h5M5.5 9.5h5M5.5 12h2" stroke={DIM} strokeWidth="0.9" strokeLinecap="round" />
      </svg>
    );
  }
  // doc / text fallback
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <path d="M3 1.5h7l3 3v10H3V1.5Z" stroke={DIM} strokeWidth="1" fill={DIM} fillOpacity="0.08" strokeLinejoin="round" />
      <path d="M10 1.5v3h3" stroke={DIM} strokeWidth="1" fill="none" strokeLinejoin="round" />
      {isDoc && <path d="M5.5 9.5h5M5.5 12h3.5" stroke={DIM} strokeWidth="0.9" strokeLinecap="round" />}
    </svg>
  );
}

interface Props {
  files: ChangedFile[];
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

type ActionKey = "reveal" | "external";

/**
 * Card shown after an assistant turn listing files the agent *generated*
 * (spreadsheets, docs, images, data exports, …). Each row offers three ways
 * to use the file: open it in the right-hand viewer, reveal its folder in the
 * OS file manager, or open it with the default external app.
 */
export function GeneratedFilesCard({ files, cwd, onOpenFile }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, { action: ActionKey; ok: boolean }>>({});
  const [actionError, setActionError] = useState<{ filePath: string; message: string } | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToggle = files.length > MAX_COLLAPSED;
  const visible = showToggle && !expanded ? files.slice(0, MAX_COLLAPSED) : files;

  useEffect(() => () => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
  }, []);

  const runAction = async (filePath: string, action: ActionKey) => {
    const endpoint = action === "reveal" ? "/api/files/reveal" : "/api/files/open-external";
    const resolved = resolveFilePath(filePath, cwd);
    setFeedback((prev) => ({ ...prev, [filePath]: { action, ok: true } }));
    let ok = false;
    let message = "";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: resolved }),
      });
      ok = response.ok;
      if (!ok) {
        // Surface the server error (e.g. "File not found" when the agent
        // deleted the file after generating it) instead of a silent flash.
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
      errorTimerRef.current = setTimeout(() => setActionError(null), 5000);
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
          <path d="M12 2v4m0 12v4M2 12h4m12 0h4" />
          <circle cx="12" cy="12" r="3.5" />
        </svg>
        <span>{t("files.generatedFiles", { count: files.length })}</span>
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
          return (
            <div
              key={file.filePath}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "4px 10px",
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
                  padding: 0,
                  background: "none",
                  border: "none",
                  cursor: onOpenFile ? "pointer" : "default",
                  color: "var(--text)",
                  fontSize: 12,
                  textAlign: "left",
                  overflow: "hidden",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              >
                <GeneratedFileTypeIcon filePath={file.filePath} />
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
                <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{getExt(file.filePath) || "file"}</span>
              </button>

              <span style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                {/* Reveal in folder */}
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
                {/* Open with external app */}
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
