"use client";

import { useCallback, useEffect, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";

interface UploadEntry {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  kind: "sheet" | "image" | "other";
}

interface UploadsStats {
  totalBytes: number;
  maxBytes: number;
  files: UploadEntry[];
  dir: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function kindLabel(kind: UploadEntry["kind"]): string {
  if (kind === "sheet") return "xlsx/univer";
  if (kind === "image") return "image";
  return "file";
}

function KindIcon({ kind }: { kind: UploadEntry["kind"] }) {
  const color = kind === "sheet" ? "#4ade80" : kind === "image" ? "#60a5fa" : "var(--text-dim)";
  return (
    <span
      style={{
        width: 20,
        height: 20,
        flexShrink: 0,
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        color,
        fontSize: 9,
        fontWeight: 700,
      }}
    >
      {kind === "sheet" ? "表" : kind === "image" ? "图" : "档"}
    </span>
  );
}

export function UploadsManager({ onClose, onOpenFile }: { onClose: () => void; onOpenFile?: (path: string, name: string) => void }) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [stats, setStats] = useState<UploadsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [editingDir, setEditingDir] = useState(false);
  const [dirInput, setDirInput] = useState("");
  const [dirBusy, setDirBusy] = useState(false);
  const [dirMessage, setDirMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/uploads");
      const data = (await res.json()) as UploadsStats & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStats(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = useCallback(async (name: string) => {
    setBusyName(name);
    setError(null);
    try {
      const res = await fetch(`/api/uploads?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyName(null);
    }
  }, [refresh]);

  const handleOpenDir = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/uploads?open=1", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleSaveDir = useCallback(async () => {
    setDirBusy(true);
    setDirMessage(null);
    try {
      const res = await fetch(`/api/uploads?dir=${encodeURIComponent(dirInput)}`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDirMessage({ ok: true, text: t("uploads.dirSaved") });
      setEditingDir(false);
      await refresh();
    } catch (e) {
      setDirMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setDirBusy(false);
    }
  }, [dirInput, refresh, t]);

  const handleResetDir = useCallback(async () => {
    setDirBusy(true);
    setDirMessage(null);
    try {
      const res = await fetch("/api/uploads?dir=", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDirMessage({ ok: true, text: t("uploads.dirSaved") });
      setDirInput("");
      setEditingDir(false);
      await refresh();
    } catch (e) {
      setDirMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setDirBusy(false);
    }
  }, [refresh, t]);

  const percent = stats && stats.maxBytes > 0
    ? Math.min(100, Math.round((stats.totalBytes / stats.maxBytes) * 100))
    : 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 720,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "70vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", flexShrink: 0 }}>
              {t("uploads.title")}
            </span>
            <code
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                maxWidth: 340,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={stats?.dir}
            >
              {stats?.dir ?? "…"}
            </code>
            <button
              type="button"
              onClick={() => {
                setDirInput(stats?.dir ?? "");
                setDirMessage(null);
                setEditingDir((v) => !v);
              }}
              title={t("uploads.changeDir")}
              style={{
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "3px 8px",
                fontSize: 11,
                color: "var(--text)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              {t("uploads.changeDir")}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={handleOpenDir}
              title={t("uploads.openDir")}
              style={{
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "5px 10px",
                fontSize: 12,
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              {t("uploads.openDir")}
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              title={t("uploads.refresh")}
              style={{
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "5px 10px",
                fontSize: 12,
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              {t("uploads.refresh")}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("i18n.cancel")}
              style={{
                background: "none",
                border: "none",
                borderRadius: 6,
                padding: "5px 8px",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 15,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Change-directory editor */}
        {editingDir && (
          <div
            style={{
              padding: "10px 18px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-panel)",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                type="text"
                value={dirInput}
                onChange={(e) => setDirInput(e.target.value)}
                placeholder={t("uploads.dirPlaceholder")}
                disabled={dirBusy}
                spellCheck={false}
                style={{
                  flex: 1,
                  minWidth: 220,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text)",
                  outline: "none",
                }}
              />
              <button
                type="button"
                onClick={() => void handleSaveDir()}
                disabled={dirBusy}
                style={{
                  background: "var(--accent)",
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 12px",
                  fontSize: 12,
                  color: "#fff",
                  cursor: dirBusy ? "not-allowed" : "pointer",
                  flexShrink: 0,
                }}
              >
                {dirBusy ? "…" : t("uploads.dirSave")}
              </button>
              <button
                type="button"
                onClick={() => void handleResetDir()}
                disabled={dirBusy}
                style={{
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "5px 10px",
                  fontSize: 12,
                  color: "var(--text)",
                  cursor: dirBusy ? "not-allowed" : "pointer",
                  flexShrink: 0,
                }}
              >
                {t("uploads.dirReset")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingDir(false);
                  setDirMessage(null);
                }}
                disabled={dirBusy}
                style={{
                  background: "none",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "5px 10px",
                  fontSize: 12,
                  color: "var(--text-muted)",
                  cursor: dirBusy ? "not-allowed" : "pointer",
                  flexShrink: 0,
                }}
              >
                {t("uploads.dirCancel")}
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
              {t("uploads.dirHint")}
            </div>
            {dirMessage && (
              <div style={{ fontSize: 11, color: dirMessage.ok ? "#4ade80" : "#f87171", marginTop: 6 }}>
                {dirMessage.text}
              </div>
            )}
          </div>
        )}

        {/* Quota bar */}
        {stats && (
          <div style={{ padding: "10px 18px 0", flexShrink: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
              <span>{t("uploads.usage", { used: formatBytes(stats.totalBytes), max: formatBytes(stats.maxBytes) })}</span>
              <span>{percent}%</span>
            </div>
            <div style={{ height: 5, borderRadius: 3, background: "var(--bg-panel)", border: "1px solid var(--border)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${percent}%`,
                  background: percent >= 90 ? "#f87171" : "var(--accent)",
                  transition: "width 0.2s",
                }}
              />
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
              {t("uploads.autoEvictHint")}
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              margin: "8px 18px 0",
              padding: "6px 10px",
              borderRadius: 6,
              background: "rgba(248,113,113,0.10)",
              border: "1px solid rgba(248,113,113,0.30)",
              color: "#f87171",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        {/* File list */}
        <div style={{ flex: 1, overflow: "auto", padding: "10px 12px" }}>
          {loading && !stats ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              {t("uploads.loading")}
            </div>
          ) : !stats || stats.files.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
              {t("uploads.empty")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {stats.files.map((file) => (
                <div
                  key={file.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                  }}
                >
                  <KindIcon kind={file.kind} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontFamily: "var(--font-mono)",
                        color: "var(--text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={file.name}
                    >
                      {file.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", gap: 10 }}>
                      <span>{formatBytes(file.size)}</span>
                      <span>{formatTime(file.mtimeMs)}</span>
                      <span>{kindLabel(file.kind)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      // 打开文件后直接关闭弹窗，避免遮住右侧已打开的文件面板
                      onOpenFile?.(file.path, file.name);
                      onClose();
                    }}
                    disabled={!onOpenFile}
                    title={t("uploads.openHint")}
                    style={{
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "4px 9px",
                      fontSize: 12,
                      color: "var(--accent)",
                      cursor: onOpenFile ? "pointer" : "not-allowed",
                      flexShrink: 0,
                    }}
                  >
                    {t("uploads.open")}
                  </button>
                  <a
                    href={`/api/uploads?download=${encodeURIComponent(file.name)}`}
                    download={file.name}
                    title={t("uploads.download")}
                    style={{
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "4px 9px",
                      fontSize: 12,
                      color: "var(--text)",
                      cursor: "pointer",
                      textDecoration: "none",
                      flexShrink: 0,
                    }}
                  >
                    {t("uploads.download")}
                  </a>
                  <button
                    type="button"
                    onClick={() => void handleDelete(file.name)}
                    disabled={busyName === file.name}
                    title={t("uploads.delete")}
                    style={{
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "4px 9px",
                      fontSize: 12,
                      color: "#f87171",
                      cursor: busyName === file.name ? "not-allowed" : "pointer",
                      flexShrink: 0,
                    }}
                  >
                    {busyName === file.name ? "…" : t("uploads.delete")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
