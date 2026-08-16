"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useAccentColor, normalizeHex } from "@/hooks/useAccentColor";
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

interface UpdateCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  changelogUrl: string;
  canAutoUpdate: boolean;
  unavailableReason?: string;
  published: boolean;
  installMode: "global" | "source";
  compat: { ok: boolean; piVersion: string; errors: string[] };
}

interface UpdateMessage {
  kind: "ok" | "error";
  text: string;
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
  const { accent, setAccentColor, resetAccentColor, presets } = useAccentColor({ apply: false });
  const [customColor, setCustomColor] = useState(accent);
  const [version, setVersion] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  // Pi Studio 应用更新检查状态
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<UpdateMessage | null>(null);
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
  const piVersion = process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0";
  // Dragging the color picker fires onChange continuously; debounce the actual
  // theme application so the page only re-renders after the pointer pauses.
  const accentDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (accentDebounceRef.current) clearTimeout(accentDebounceRef.current);
  }, []);

  const handleAccentPick = useCallback((color: string) => {
    setCustomColor(color); // instant local preview (lightweight)
    if (accentDebounceRef.current) clearTimeout(accentDebounceRef.current);
    accentDebounceRef.current = setTimeout(() => setAccentColor(color), 500);
  }, [setAccentColor]);

  const handleCheckUpdates = useCallback(async () => {
    setCheckingUpdates(true);
    setUpdateMessage(null);
    try {
      const res = await fetch("/api/update/check");
      const data = (await res.json()) as UpdateCheckResult & { error?: string };
      if (!res.ok) {
        setUpdateMessage({ kind: "error", text: data.error ?? t("settings.checkUpdates") });
        return;
      }
      setUpdateInfo(data);
      if (data.updateAvailable && !data.canAutoUpdate) {
        // 源码模式 / 只读目录：给出具体原因，而不是笼统的“不支持”
        setUpdateMessage({
          kind: "error",
          text: data.installMode === "source" ? t("settings.sourceMode") : t("settings.updateUnavailable"),
        });
      }
      if (!data.compat.ok) {
        setUpdateMessage({ kind: "error", text: t("settings.compatFailed", { errors: data.compat.errors.join("; ") }) });
      }
    } catch (error) {
      setUpdateMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setCheckingUpdates(false);
    }
  }, [t]);

  const handleUpdateNow = useCallback(async () => {
    if (!updateInfo?.latest) return;
    setUpdating(true);
    setUpdateMessage(null);
    try {
      const res = await fetch("/api/update/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: updateInfo.latest }),
      });
      const data = (await res.json()) as { updatedTo?: string; error?: string };
      if (!res.ok) {
        setUpdateMessage({ kind: "error", text: t("settings.updateFailed", { error: data.error ?? "" }) });
        return;
      }
      setUpdateMessage({ kind: "ok", text: t("settings.updateDone", { version: data.updatedTo ?? updateInfo.latest }) });
      // 更新后重新检查一次，刷新版本状态
      try {
        const re = await fetch("/api/update/check");
        if (re.ok) setUpdateInfo((await re.json()) as UpdateCheckResult);
      } catch { /* ignore */ }
    } catch (error) {
      setUpdateMessage({ kind: "error", text: t("settings.updateFailed", { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setUpdating(false);
    }
  }, [updateInfo, t]);

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

  const updateBtnStyle: CSSProperties = {
    height: 26,
    padding: "0 10px",
    background: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text)",
    cursor: "pointer",
    fontSize: 11.5,
    fontWeight: 500,
  };

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

        {/* Accent color: preset palette + free-form picker */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 10px",
            borderRadius: 8,
          }}
        >
          <span
            style={{
              flexShrink: 0,
              width: 14,
              height: 14,
              borderRadius: 4,
              background: accent,
              boxShadow: "0 0 0 1px var(--border), 0 0 0 3px var(--accent-soft)",
            }}
          />
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
              {t("settings.accentColor")}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
              {t("settings.accentColorDesc")}
            </span>
          </span>
          <button
            type="button"
            onClick={resetAccentColor}
            title={t("settings.resetAccent")}
            style={{
              flexShrink: 0,
              height: 24,
              padding: "0 9px",
              background: "var(--bg-hover)",
              border: "1px solid var(--border)",
              borderRadius: 5,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            {t("settings.resetAccent")}
          </button>
          {/* free-form color picker */}
          <label
            title={t("settings.customAccent")}
            style={{
              flexShrink: 0,
              position: "relative",
              width: 30,
              height: 30,
              borderRadius: 8,
              overflow: "hidden",
              cursor: "pointer",
              border: "1px solid var(--border)",
              background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
            }}
          >
            <input
              type="color"
              value={normalizeHex(customColor) ?? "#5BAF68"}
              onChange={(e) => handleAccentPick(e.target.value)}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                border: "none",
                padding: 0,
                opacity: 0,
                cursor: "pointer",
              }}
            />
            <span
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
                color: "#fff",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 22a10 10 0 1 1 10-10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </span>
          </label>
        </div>
        {/* preset swatches */}
        <div style={{ display: "flex", gap: 8, padding: "4px 10px 10px", flexWrap: "wrap" }}>
          {presets.map((preset) => {
            const selected = accent.toLowerCase() === preset.value.toLowerCase();
            return (
              <button
                key={preset.name}
                type="button"
                title={preset.name}
                onClick={() => handleAccentPick(preset.value)}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  padding: 0,
                  background: preset.value,
                  border: selected ? "2px solid var(--text)" : "1px solid var(--border)",
                  boxShadow: selected ? `0 0 0 2px var(--accent-soft)` : "none",
                  cursor: "pointer",
                  transition: "transform 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.12)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
              />
            );
          })}
        </div>

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

        {divider}
        {sectionTitle(t("settings.updates"))}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px" }}>
          <span style={{ color: "var(--text-muted)", flexShrink: 0, display: "inline-flex" }}>
            <IconRefresh />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12.5, fontWeight: 500 }}>{t("settings.piStudioVersion")}</span>
            <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)", marginTop: 1 }}>{t("settings.piStudioVersionDesc")}</span>
          </span>
          <span style={{ fontSize: 11.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>v{appVersion}</span>
        </div>
        <div style={{ display: "flex", gap: 8, padding: "0 10px 8px", flexWrap: "wrap" }}>
          <button
            type="button"
            disabled={checkingUpdates || updating}
            onClick={handleCheckUpdates}
            style={{...updateBtnStyle}}
          >
            {checkingUpdates ? t("settings.checkingUpdates") : t("settings.checkUpdates")}
          </button>
          {updateInfo?.updateAvailable && updateInfo.latest && updateInfo.canAutoUpdate && (
            <button
              type="button"
              disabled={updating || checkingUpdates}
              onClick={handleUpdateNow}
              style={{...updateBtnStyle, background: "var(--accent)", color: "#fff"}}
            >
              {updating ? t("settings.updating") : t("settings.updateNow", { version: updateInfo.latest })}
            </button>
          )}
          {updateInfo?.changelogUrl && (
            <a
              href={updateInfo.changelogUrl}
              target="_blank"
              rel="noreferrer"
              style={{...updateBtnStyle, textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center"}}
            >
              {t("settings.changelog")}
            </a>
          )}
        </div>
        {updateInfo && (
          <div style={{ padding: "2px 10px 8px", fontSize: 11.5, lineHeight: 1.5, color: "var(--text-muted)" }}>
            {!updateInfo.published ? (
              <span>{t("settings.notPublished")}</span>
            ) : updateInfo.updateAvailable && updateInfo.latest ? (
              <span>{t("settings.updateAvailable", { version: updateInfo.latest })}</span>
            ) : (
              <span>{t("settings.upToDate")}</span>
            )}
            {!updateInfo.canAutoUpdate && updateInfo.updateAvailable && updateInfo.installMode === "source" && (
              <span style={{ display: "block", color: "var(--text-dim)", marginTop: 2 }}>{t("settings.sourceMode")}</span>
            )}
            <span style={{ display: "block", marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
              {t("settings.piEngineInfo", { version: piVersion })}
            </span>
            {!updateInfo.compat.ok && (
              <span style={{ display: "block", marginTop: 2, color: "#e5484d" }}>{t("settings.compatFailed", { errors: updateInfo.compat.errors.join("; ") })}</span>
            )}
          </div>
        )}
        {updateMessage && (
          <div
            style={{
              padding: "4px 10px 10px",
              fontSize: 11.5,
              lineHeight: 1.5,
              color: updateMessage.kind === "ok" ? "var(--accent)" : "#e5484d",
            }}
          >
            {updateMessage.text}
          </div>
        )}
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
function IconRefresh() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}
