"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";
import { buildEntriesFromFiles, filterFileEntries } from "@/lib/file-fuzzy";
import { getFileName, joinFilePath } from "@/lib/file-paths";
import type { Activity } from "./ActivityBar";

export type PaletteMode = "files" | "all";

interface CommandDef {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: ReactNode;
  run: () => void;
}

interface Props {
  open: boolean;
  mode: PaletteMode;
  cwd: string | null;
  onClose: () => void;
  onOpenFile: (filePath: string, fileName: string) => void;
  onSelectSession: (session: SessionInfo) => void;
  onNewSession: () => void;
  onSelectActivity: (activity: Activity) => void;
  onToggleTheme: () => void;
  onOpenModels: () => void;
  onOpenSkills: () => void;
  onOpenPlugins: () => void;
  onOpenUploads: () => void;
}

const FILE_RESULT_LIMIT = 12;
const SESSION_RESULT_LIMIT = 8;

export function CommandPalette(props: Props) {
  const { open, mode, cwd, onClose, onOpenFile, onSelectSession } = props;
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastOpenRef = useRef(false);

  // Reset state each time the palette opens.
  useEffect(() => {
    if (open && !lastOpenRef.current) {
      setQuery("");
      setActiveIndex(0);
    }
    lastOpenRef.current = open;
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Fetch the file index + sessions once when opened.
  useEffect(() => {
    if (!open) return;
    if (cwd) {
      fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setFiles((d?.files as string[]) ?? []))
        .catch(() => setFiles([]));
    } else {
      setFiles([]);
    }
    if (mode === "all") {
      fetch("/api/sessions")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setSessions((d?.sessions as SessionInfo[]) ?? []))
        .catch(() => setSessions([]));
    }
  }, [open, cwd, mode]);

  const commands = useMemo<CommandDef[]>(() => {
    const list: CommandDef[] = [
      {
        id: "new-session",
        label: t("activity.newSession"),
        hint: t("activity.newSessionHint"),
        keywords: "new session chat",
        icon: <PlusIcon />,
        run: props.onNewSession,
      },
      {
        id: "go-sessions",
        label: t("activity.sessions"),
        hint: t("activity.sessionsHint"),
        keywords: "chat sessions conversation",
        icon: <ChatIcon />,
        run: () => props.onSelectActivity("sessions"),
      },
      {
        id: "go-skills",
        label: t("activity.skills"),
        hint: t("activity.skillsHint"),
        keywords: "skills plugins tools",
        icon: <BoltIcon />,
        run: () => props.onSelectActivity("skills"),
      },
      {
        id: "go-terminal",
        label: t("activity.terminal"),
        hint: t("activity.terminalHint"),
        keywords: "shell terminal command line",
        icon: <TerminalIcon />,
        run: () => props.onSelectActivity("terminal"),
      },
      {
        id: "go-settings",
        label: t("common.settings"),
        hint: t("activity.settingsHint"),
        keywords: "settings preferences",
        icon: <GearIcon />,
        run: () => props.onSelectActivity("settings"),
      },
      {
        id: "toggle-theme",
        label: t("settings.darkMode"),
        hint: t("settings.darkModeDesc"),
        keywords: "dark light theme appearance",
        icon: <MoonIcon />,
        run: props.onToggleTheme,
      },
      {
        id: "open-models",
        label: t("common.models"),
        hint: t("settings.modelsDesc"),
        keywords: "model provider config",
        icon: <BoxIcon />,
        run: props.onOpenModels,
      },
      {
        id: "open-plugins",
        label: t("common.plugins"),
        hint: t("settings.pluginsDesc"),
        keywords: "plugin package extension",
        icon: <GridIcon />,
        run: props.onOpenPlugins,
      },
      {
        id: "open-uploads",
        label: t("uploads.sidebar"),
        hint: t("settings.uploadsDesc"),
        keywords: "files uploads storage",
        icon: <UploadIcon />,
        run: props.onOpenUploads,
      },
    ];
    if (cwd) {
      list.push({
        id: "open-skills",
        label: t("common.skills"),
        hint: t("settings.skillsDesc"),
        keywords: "skill install",
        icon: <BoltIcon />,
        run: props.onOpenSkills,
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, cwd, props.onNewSession, props.onSelectActivity, props.onToggleTheme, props.onOpenModels, props.onOpenPlugins, props.onOpenUploads, props.onOpenSkills]);

  const lowerQuery = query.trim().toLowerCase();

  const visibleCommands = useMemo(() => {
    if (!lowerQuery) return commands.slice(0, 5);
    return commands
      .filter((c) => `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(lowerQuery))
      .slice(0, 8);
  }, [commands, lowerQuery]);

  const visibleSessions = useMemo(() => {
    if (mode !== "all") return [];
    if (!lowerQuery) return sessions.slice(0, SESSION_RESULT_LIMIT);
    return sessions
      .filter((s) => `${s.name ?? ""} ${s.firstMessage} ${s.cwd}`.toLowerCase().includes(lowerQuery))
      .slice(0, SESSION_RESULT_LIMIT);
  }, [mode, lowerQuery, sessions]);

  const visibleFiles = useMemo(() => {
    if (!cwd) return [];
    if (!lowerQuery) {
      // Show a few shallow files as hints.
      return buildEntriesFromFiles(files)
        .filter((e) => !e.isDir)
        .slice(0, FILE_RESULT_LIMIT)
        .map((e) => ({ path: e.path, isDir: false }));
    }
    return filterFileEntries(buildEntriesFromFiles(files), query.trim(), FILE_RESULT_LIMIT);
  }, [cwd, files, lowerQuery, query]);

  // Flat list of selectable rows (headers excluded).
  type Row =
    | { kind: "header"; label: string }
    | { kind: "command"; cmd: CommandDef }
    | { kind: "session"; session: SessionInfo }
    | { kind: "file"; path: string; isDir: boolean };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (mode === "all") {
      if (visibleCommands.length) {
        out.push({ kind: "header", label: t("activity.commandsSection") });
        visibleCommands.forEach((c) => out.push({ kind: "command", cmd: c }));
      }
      if (visibleSessions.length) {
        out.push({ kind: "header", label: t("activity.sessionsSection") });
        visibleSessions.forEach((s) => out.push({ kind: "session", session: s }));
      }
    }
    if (visibleFiles.length) {
      out.push({ kind: "header", label: t("activity.filesSection") });
      visibleFiles.forEach((f) => out.push({ kind: "file", path: f.path, isDir: f.isDir }));
    }
    return out;
  }, [mode, visibleCommands, visibleSessions, visibleFiles, t]);

  const selectableCount = rows.filter((r) => r.kind !== "header").length;

  useEffect(() => {
    setActiveIndex(0);
  }, [rows]);

  const runRow = useCallback(
    (row: Row) => {
      if (row.kind === "command") {
        onClose();
        row.cmd.run();
      } else if (row.kind === "session") {
        onClose();
        onSelectSession(row.session);
      } else if (row.kind === "file" && cwd) {
        const abs = joinFilePath(cwd, row.path);
        onClose();
        onOpenFile(abs, getFileName(abs));
      }
    },
    [cwd, onClose, onOpenFile, onSelectSession],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(selectableCount - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const selectable = rows.filter((r) => r.kind !== "header");
        const row = selectable[activeIndex];
        if (row) runRow(row);
      }
    },
    [activeIndex, onClose, rows, runRow, selectableCount],
  );

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-palette-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  let selectableIdx = -1;

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 700, background: "rgba(0,0,0,0.28)" }} onClick={onClose} />
      <div
        style={{
          position: "fixed",
          top: "12vh",
          left: "50%",
          transform: "translateX(-50%)",
          width: 560,
          maxWidth: "calc(100vw - 32px)",
          zIndex: 701,
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 18px 48px rgba(0,0,0,0.22)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px", borderBottom: "1px solid var(--hairline)" }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === "files" ? t("activity.quickOpenPlaceholder") : t("activity.palettePlaceholder")}
            style={{
              flex: 1,
              fontSize: 14,
              fontFamily: "inherit",
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text)",
              padding: 0,
            }}
          />
          <kbd style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px" }}>
            Esc
          </kbd>
        </div>

        <div ref={listRef} style={{ maxHeight: "min(58vh, 460px)", overflowY: "auto", padding: 6 }}>
          {rows.length === 0 && (
            <div style={{ padding: "20px 14px", color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>
              {t("i18n.noResults")}
            </div>
          )}
          {rows.map((row, i) => {
            if (row.kind === "header") {
              return (
                <div key={`h-${i}`} style={{ padding: "10px 10px 4px", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-dim)" }}>
                  {row.label}
                </div>
              );
            }
            selectableIdx += 1;
            const idx = selectableIdx;
            const isActive = idx === activeIndex;
            const icon = row.kind === "command" ? row.cmd.icon : row.kind === "session" ? <ChatIcon /> : <FileIcon isDir={row.isDir} />;
            const label = row.kind === "command" ? row.cmd.label : row.kind === "session" ? (row.session.name || row.session.firstMessage.slice(0, 50) || row.session.id.slice(0, 12)) : row.path;
            const hint = row.kind === "command" ? row.cmd.hint : row.kind === "session" ? row.session.cwd : (row.isDir ? "dir" : "file");
            return (
              <button
                key={`${row.kind}-${i}`}
                type="button"
                data-palette-idx={idx}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => runRow(row)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "7px 10px",
                  background: isActive ? "var(--bg-selected)" : "transparent",
                  border: "none",
                  borderRadius: 8,
                  color: "var(--text)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 12.5,
                  transition: "background 0.08s",
                }}
              >
                <span style={{ color: isActive ? "var(--accent)" : "var(--text-muted)", flexShrink: 0, display: "inline-flex" }}>{icon}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                {hint && (
                  <span style={{ flexShrink: 0, fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)", maxWidth: "46%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {hint}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function BoltIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
function BoxIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}
function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}
function FileIcon({ isDir }: { isDir: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {isDir ? (
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      ) : (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </>
      )}
    </svg>
  );
}
