"use client";

import { useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { BranchNavigator } from "./BranchNavigator";
import type { SessionTreeNode } from "@/lib/types";

interface Props {
  cwd: string | null;
  hasSession: boolean;
  systemPrompt: string | null;
  branchTree: SessionTreeNode[];
  branchActiveLeafId: string | null;
  onBranchLeafChange: (leafId: string | null) => void;
  onOpenModels: () => void;
  onOpenSkills: () => void;
  onOpenPlugins: () => void;
  onOpenUploads: () => void;
  onViewHistory: () => void;
  onAutoName: () => void;
}

interface Row {
  label: string;
  desc?: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  trailing?: ReactNode;
}

/** Second-column panel shown when the Settings activity is selected.
 *  Hosts the app/session settings formerly in the sidebar footer popover. */
export function SettingsPanel({ cwd, hasSession, systemPrompt, branchTree, branchActiveLeafId, onBranchLeafChange, onOpenModels, onOpenSkills, onOpenPlugins, onOpenUploads, onViewHistory, onAutoName }: Props) {
  const { t, locale, setLocale, supportedLocales } = useI18n();
  const { isDark, toggleTheme } = useTheme();
  const [version, setVersion] = useState(false);
  const [showSystem, setShowSystem] = useState(false);

  const sessionRows: Row[] = [
    {
      label: t("history.label"),
      desc: t("history.unsaved"),
      icon: <IconHistory />,
      onClick: onViewHistory,
      disabled: !hasSession,
    },
    {
      label: t("title.generate"),
      icon: <IconWand />,
      onClick: onAutoName,
      disabled: !hasSession,
    },
    {
      label: t("system.label"),
      icon: <IconDoc />,
      onClick: () => setShowSystem((v) => !v),
      disabled: !hasSession,
    },
  ];

  const resourceRows: Row[] = [
    {
      label: t("common.models"),
      desc: t("settings.modelsDesc"),
      icon: <IconBox />,
      onClick: onOpenModels,
    },
    {
      label: t("common.skills"),
      desc: t("settings.skillsDesc"),
      icon: <IconBolt />,
      onClick: onOpenSkills,
      disabled: !cwd,
    },
    {
      label: t("common.plugins"),
      desc: t("settings.pluginsDesc"),
      icon: <IconGrid />,
      onClick: onOpenPlugins,
      disabled: !cwd,
    },
    {
      label: t("uploads.sidebar"),
      desc: t("settings.uploadsDesc"),
      icon: <IconUpload />,
      onClick: onOpenUploads,
    },
  ];

  const appearanceRows: Row[] = [
    {
      label: t("settings.darkMode"),
      desc: t("settings.darkModeDesc"),
      icon: <IconMoon />,
      onClick: () => toggleTheme(),
      trailing: (
        <Switch
          checked={isDark}
          onChange={() => toggleTheme()}
          ariaLabel={t("settings.darkMode")}
        />
      ),
    },
  ];

  const renderRow = (row: Row) => (
    <button
      key={row.label}
      type="button"
      disabled={row.disabled}
      onClick={row.onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "9px 10px",
        background: "transparent",
        border: "none",
        borderRadius: 8,
        color: row.disabled ? "var(--text-dim)" : "var(--text)",
        cursor: row.disabled ? "not-allowed" : "pointer",
        textAlign: "left",
        opacity: row.disabled ? 0.55 : 1,
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => {
        if (!row.disabled) e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!row.disabled) e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ color: "var(--text-muted)", flexShrink: 0, display: "inline-flex" }}>{row.icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12.5, fontWeight: 500 }}>{row.label}</span>
        {row.desc && (
          <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)", marginTop: 1 }}>{row.desc}</span>
        )}
      </span>
      {row.trailing}
    </button>
  );

  const sectionTitle = (label: string) => (
    <div style={{ padding: "10px 10px 3px", fontSize: 11, fontWeight: 600, color: "var(--text-dim)", letterSpacing: "0.03em", textTransform: "uppercase" }}>
      {label}
    </div>
  );

  const divider = <div style={{ height: 1, background: "var(--hairline)", margin: "8px 4px" }} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "14px 12px 8px", flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }}>
          {t("common.settings")}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
        {sectionTitle(t("settings.session"))}
        {sessionRows.map(renderRow)}
        {showSystem && hasSession && systemPrompt && (
          <div style={{ padding: "6px 10px", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", maxHeight: 160, overflowY: "auto" }}>
            {systemPrompt}
          </div>
        )}
        {hasSession && (
          <div style={{ marginTop: 6 }}>
            <BranchNavigator tree={branchTree} activeLeafId={branchActiveLeafId} onLeafChange={onBranchLeafChange} hasSession={hasSession} />
          </div>
        )}

        {divider}
        {sectionTitle(t("settings.resources"))}
        {resourceRows.map(renderRow)}

        {divider}
        {sectionTitle(t("settings.appearance"))}
        {appearanceRows.map(renderRow)}

        {divider}
        {sectionTitle(t("common.language"))}
        {supportedLocales.map((plugin) => (
          <button
            key={plugin.id}
            type="button"
            onClick={() => setLocale(plugin.id as typeof locale)}
            role="menuitemradio"
            aria-checked={locale === plugin.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "8px 10px",
              background: locale === plugin.id ? "var(--bg-selected)" : "transparent",
              border: "none",
              borderRadius: 8,
              color: "var(--text)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 12.5,
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => {
              if (locale !== plugin.id) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (locale !== plugin.id) e.currentTarget.style.background = "transparent";
            }}
          >
            <span style={{ flex: 1 }}>{plugin.label}</span>
            {locale === plugin.id && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
        ))}
      </div>

      <div style={{ flexShrink: 0, padding: "8px 12px 12px", borderTop: "1px solid var(--hairline)", fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
        <button
          type="button"
          onClick={() => setVersion((v) => !v)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            color: "inherit",
            fontFamily: "inherit",
            fontSize: "inherit",
          }}
        >
          {version
            ? `v${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"} · pi ${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}`
            : "Pi Studio"}
        </button>
      </div>
    </div>
  );
}

function Switch({ checked, onChange, ariaLabel }: { checked: boolean; onChange: () => void; ariaLabel: string }) {
  return (
    <span
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onChange();
        }
      }}
      style={{
        width: 30,
        height: 17,
        borderRadius: 9,
        background: checked ? "var(--accent)" : "var(--bg-selected)",
        border: "1px solid var(--border)",
        position: "relative",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 0.15s",
        display: "inline-block",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 1.5,
          left: checked ? 14 : 2,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
          transition: "left 0.15s",
        }}
      />
    </span>
  );
}

function IconBox() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}
function IconBolt() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
function IconGrid() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function IconUpload() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}
function IconMoon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
function IconHistory() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function IconWand() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 4 5 5L7 22l-5-5Z" />
      <path d="m14 5 5 5" />
    </svg>
  );
}
function IconDoc() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  );
}
