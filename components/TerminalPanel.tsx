"use client";

import { useI18n } from "@/hooks/useI18n";

interface Props {
  cwd: string | null;
}

/**
 * Second-column panel for the Terminal activity.
 *
 * The Agent already runs shell commands on the user's behalf (visible as tool
 * calls in the chat). A persistent *user* shell is intentionally not wired to
 * a backend here — this panel is the layout anchor for that future surface and
 * shows the active project directory the terminal would open in.
 */
export function TerminalPanel({ cwd }: Props) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "14px 12px 8px", flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }}>
          {t("activity.terminal")}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px" }}>
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 9px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#f87171" }} />
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#facc15" }} />
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#4ade80" }} />
            <span style={{ marginLeft: 6, fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
              {t("activity.terminalTitle")}
            </span>
          </div>
          <div style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.7, color: "var(--text-muted)" }}>
            <div>
              <span style={{ color: "var(--accent)" }}>pi</span>
              <span style={{ color: "var(--text-dim)" }}>@</span>
              <span style={{ color: "var(--accent)" }}>studio</span>
              <span style={{ color: "var(--text-dim)" }}>:</span>
              <span style={{ color: "var(--text)" }}>{cwd ? `~${cwd}` : "~"}</span>
              <span style={{ color: "var(--text-dim)" }}>$</span>
            </div>
            <div style={{ color: "var(--text-dim)", marginTop: 6, fontFamily: "inherit" }}>
              {t("activity.terminalHint")}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
          {t("activity.terminalNote")}
        </div>
      </div>
    </div>
  );
}
