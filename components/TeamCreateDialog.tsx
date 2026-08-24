/**
 * TeamCreateDialog —— 转换项目组对话框。
 *  仅 convert 模式：已有会话转项目组（POST /api/teams/convert，历史导入）。
 *  创建模式已改为侧栏直接 POST，不再弹窗。
 */
"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export interface TeamCreateDialogProps {
  mode: "convert";
  sessionId?: string;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

export function TeamCreateDialog({ sessionId, onClose, onCreated }: TeamCreateDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/teams/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, name: name.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onCreated(sessionId ?? data.team.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 20,
          width: 400,
          maxWidth: "92vw",
          boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 20 }}>👥</span>
          <h2 style={{ margin: 0, fontSize: 16 }}>{t("team.convertTitle")}</h2>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
            {t("team.name")}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("team.namePlaceholder")}
              style={inputStyle}
            />
          </label>

          {error && <div style={{ color: "#dc2626", fontSize: 12 }}>⚠️ {error}</div>}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button onClick={onClose} style={btnSecondary} disabled={busy}>
              {t("team.cancel")}
            </button>
            <button onClick={() => void handleSubmit()} style={btnPrimary} disabled={busy}>
              {busy ? "…" : "🚀"} {t("team.convert")}
            </button>
          </div>

          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {t("team.convertHint")}
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 13,
  fontFamily: "inherit",
  background: "var(--bg)",
  color: "var(--text)",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const btnPrimary: React.CSSProperties = {
  background: "var(--accent)",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "8px 16px",
  fontSize: 13,
  cursor: "pointer",
};

const btnSecondary: React.CSSProperties = {
  background: "var(--bg-soft, rgba(0,0,0,0.05))",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 14px",
  fontSize: 13,
  cursor: "pointer",
};