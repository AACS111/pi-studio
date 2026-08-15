"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SkillInfo } from "@/lib/api-types";

interface Props {
  cwd: string | null;
}

export function SkillsPanel({ cwd }: Props) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
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
      const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
      const data = (await res.json().catch(() => ({}))) as { skills?: SkillInfo[]; error?: string };
      if (id !== reqRef.current) return;
      if (data.error || !data.skills) {
        setError(data.error ?? "load failed");
        return;
      }
      setSkills(data.skills);
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

  const visible = filter.trim()
    ? skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(filter.trim().toLowerCase()))
    : skills;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "14px 12px 8px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }}>
            {t("activity.skills")}
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
          placeholder={t("i18n.search")}
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
        {!cwd && <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>{t("workspace.selectProject")}</div>}
        {cwd && loading && <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>{t("sidebar.loading")}</div>}
        {error && <div style={{ padding: "12px 10px", color: "#f87171", fontSize: 12 }}>{error}</div>}
        {cwd && !loading && !error && visible.length === 0 && (
          <div style={{ padding: "12px 10px", color: "var(--text-muted)", fontSize: 12 }}>
            {filter.trim() ? t("i18n.noResults") : t("i18n.noSkills")}
          </div>
        )}
        {visible.map((s) => (
          <div
            key={s.filePath || s.name}
            style={{ padding: "8px 10px", borderRadius: 8, marginBottom: 2 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {s.name}
              </span>
              {s.disableModelInvocation && (
                <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px" }}>
                  {t("activity.modelDisabled")}
                </span>
              )}
            </div>
            {s.description && (
              <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>
                {s.description}
              </div>
            )}
            {s.sourceInfo?.source && (
              <div style={{ marginTop: 3, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                {s.sourceInfo.source}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
