"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useAccentColor, normalizeHex, DEFAULT_ACCENT } from "@/hooks/useAccentColor";
import { useGlowBackground, GLOW_STYLE_IDS, GLOW_INTENSITY_MIN, GLOW_INTENSITY_MAX } from "@/hooks/useGlowBackground";
import {
  useGlassOpacity,
  GLASS_OPACITY_MIN,
  GLASS_OPACITY_MAX,
  GLASS_OPACITY_STEP,
} from "@/hooks/useGlassOpacity";
import {
  CONTEXT_DIET_DEFAULTS,
  CONTEXT_DIET_RANGES,
  type ContextDietSettings,
} from "@/lib/context-diet-shared";
import { BranchNavigator } from "./BranchNavigator";
import { AgentLibraryPanel } from "./AgentLibraryPanel";
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

/** 压缩触发点可选项（占模型窗口比例）。与服务端 COMPACTION_TRIGGER_RATIO_OPTIONS 对应；
 *  不直接 import 服务端模块（lib/compaction-settings.ts 依赖 node:fs）。 */
const COMPACTION_RATIO_OPTIONS: number[] = [0.25, 0.4, 0.6, 0.85];

/** Second-column panel shown when the Settings activity is selected.
 *  Hosts the app/session settings formerly in the sidebar footer popover. */
export function SettingsPanel({ cwd, hasSession, systemPrompt, branchTree, branchActiveLeafId, onBranchLeafChange, onOpenModels, onOpenSkills, onOpenPlugins, onOpenUploads, onViewHistory, onAutoName }: Props) {
  const { t, locale, setLocale, supportedLocales } = useI18n();
  const { isDark, toggleTheme } = useTheme();
  const { accent, setAccentColor, resetAccentColor, presets } = useAccentColor({ apply: false });
  const { enabled: glowEnabled, setGlowEnabled, style: glowStyle, setGlowStyle, intensity: glowIntensity, setGlowIntensity, resetGlowIntensity } = useGlowBackground();
  const {
    foreground: glassForeground,
    background: glassBackground,
    setForeground: setGlassForeground,
    setBackground: setGlassBackground,
    resetGlassOpacity,
  } = useGlassOpacity();
  const [customColor, setCustomColor] = useState(accent);
  const [version, setVersion] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [showAgentLibrary, setShowAgentLibrary] = useState(false);
  // Pi Studio 应用更新检查状态
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<UpdateMessage | null>(null);
  // 上下文自动压缩触发点（占模型窗口比例）；null = 尚未读取到
  const [compactionRatio, setCompactionRatio] = useState<number | null>(null);
  // 上下文精简（context-diet 补丁）设置；null = 尚未读取到
  const [contextDiet, setContextDiet] = useState<ContextDietSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/compaction")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { triggerRatio?: number } | null) => {
        if (!cancelled && typeof data?.triggerRatio === "number") setCompactionRatio(data.triggerRatio);
      })
      .catch(() => { /* 读不到就置空，行内显示 loading */ });
    fetch("/api/settings/context-diet")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { data?: ContextDietSettings } | null) => {
        if (!cancelled && data?.data && typeof data.data.enabled === "boolean") {
          contextDietRef.current = data.data;
          setContextDiet(data.data);
        }
      })
      .catch(() => { /* 读不到就置空，行内显示 loading */ });
    return () => { cancelled = true; };
  }, []);

  /**
   * 上下文精简的数值参数用「滑块 + 可编辑数字」：拖动/输入时先改本地 state（即时反馈），
   * 停手 350ms 再写一次 settings.json（补丁每 5s 重读，下一轮请求生效）。
   */
  const contextDietRef = useRef<ContextDietSettings | null>(null);
  const contextDietTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveContextDiet = useCallback(async () => {
    const payload = contextDietRef.current;
    if (!payload) return;
    try {
      const res = await fetch("/api/settings/context-diet", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { data?: ContextDietSettings };
      if (data?.data) {
        contextDietRef.current = data.data;
        setContextDiet(data.data);
      }
    } catch { /* 网络失败保留 UI 值，下次进入面板会重新读取 */ }
  }, []);

  const updateContextDiet = useCallback((patch: Partial<ContextDietSettings>) => {
    const current = contextDietRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    contextDietRef.current = next;
    setContextDiet(next);
    if (contextDietTimer.current) clearTimeout(contextDietTimer.current);
    contextDietTimer.current = setTimeout(() => { void saveContextDiet(); }, 350);
  }, [saveContextDiet]);

  useEffect(() => () => {
    if (contextDietTimer.current) clearTimeout(contextDietTimer.current);
  }, []);

  const cycleCompactionRatio = useCallback(async () => {
    const options = COMPACTION_RATIO_OPTIONS;
    const idx = compactionRatio === null ? -1 : options.indexOf(compactionRatio);
    const next = options[(idx + 1) % options.length];
    setCompactionRatio(next);
    try {
      await fetch("/api/settings/compaction", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggerRatio: next }),
      });
    } catch { /* 网络失败保留 UI 值，下次进入面板会重新读取 */ }
  }, [compactionRatio]);
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
      label: t("settings.compaction"),
      desc: compactionRatio === null
        ? t("settings.compactionLoading")
        : t("settings.compactionDesc", { percent: String(Math.round(compactionRatio * 100)) }),
      icon: <IconCompress />,
      onClick: () => { void cycleCompactionRatio(); },
      disabled: compactionRatio === null,
      trailing: (
        <span
          role="button"
          aria-label={t("settings.compaction")}
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); void cycleCompactionRatio(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              void cycleCompactionRatio();
            }
          }}
          style={{
            fontSize: 11.5,
            fontVariantNumeric: "tabular-nums",
            padding: "2px 9px",
            borderRadius: "var(--radius-pill)",
            border: "1px solid var(--border)",
            background: "var(--bg-selected)",
            color: "var(--text)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {compactionRatio === null ? "…" : `${Math.round(compactionRatio * 100)}%`}
        </span>
      ),
    },
    {
      label: t("system.label"),
      icon: <IconDoc />,
      onClick: () => setShowSystem((v) => !v),
      disabled: !hasSession,
    },
  ];

  const contextDietRows: Row[] = [
    {
      label: t("settings.contextDiet"),
      desc: t("settings.contextDietDesc"),
      icon: <IconCompress />,
      onClick: () => updateContextDiet({ enabled: !(contextDiet?.enabled ?? CONTEXT_DIET_DEFAULTS.enabled) }),
      disabled: contextDiet === null,
      trailing: (
        <Switch
          checked={contextDiet?.enabled ?? CONTEXT_DIET_DEFAULTS.enabled}
          onChange={() => updateContextDiet({ enabled: !(contextDiet?.enabled ?? CONTEXT_DIET_DEFAULTS.enabled) })}
          ariaLabel={t("settings.contextDiet")}
        />
      ),
    },
  ];

  /** 上下文精简的数值参数：滑块 + 可直接输入的数字框 */
  const dietSliders: Array<{
    key: "keepRecentToolResults" | "foldMinChars" | "keepRecentImages";
    label: string;
    desc: string;
    icon: ReactNode;
  }> = [
    { key: "keepRecentToolResults", label: t("settings.dietKeepResults"), desc: t("settings.dietKeepResultsDesc"), icon: <IconCompress /> },
    { key: "foldMinChars", label: t("settings.dietFoldMinChars"), desc: t("settings.dietFoldMinCharsDesc"), icon: <IconCompress /> },
    { key: "keepRecentImages", label: t("settings.dietKeepImages"), desc: t("settings.dietKeepImagesDesc"), icon: <IconUpload /> },
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
    {
      label: t("team.library.title"),
      desc: t("team.library.settingsDesc"),
      icon: <IconLibrary />,
      onClick: () => setShowAgentLibrary(true),
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
    {
      label: t("settings.glowBackground"),
      desc: t("settings.glowBackgroundDesc"),
      icon: <IconGlow />,
      onClick: () => setGlowEnabled(!glowEnabled),
      trailing: (
        <Switch
          checked={glowEnabled}
          onChange={() => setGlowEnabled(!glowEnabled)}
          ariaLabel={t("settings.glowBackground")}
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
        borderRadius: "var(--radius-sm)",
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

  /**
   * 数值参数行：左边标签+说明，下面一行是「滑块 + 可输入数字框」。
   * 不用 <button> 包住 —— 里面是真实表单控件，嵌套在 button 里是非法 HTML。
   */
  const renderDietSlider = (item: (typeof dietSliders)[number]) => {
    const range = CONTEXT_DIET_RANGES[item.key];
    const value = contextDiet ? contextDiet[item.key] : null;
    const disabled = contextDiet === null;
    return (
      <div key={item.key} style={{ padding: "8px 10px 10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "var(--text-muted)", flexShrink: 0, display: "inline-flex", opacity: disabled ? 0.55 : 1 }}>
            {item.icon}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 12.5, fontWeight: 500, color: disabled ? "var(--text-dim)" : "var(--text)" }}>
              {item.label}
            </span>
            <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)", marginTop: 1 }}>{item.desc}</span>
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, paddingLeft: 26 }}>
          <input
            type="range"
            min={range.min}
            max={range.max}
            step={range.step}
            value={value ?? range.min}
            disabled={disabled}
            aria-label={item.label}
            onChange={(e) => updateContextDiet({ [item.key]: Number(e.target.value) } as Partial<ContextDietSettings>)}
            style={{ flex: 1, minWidth: 0, accentColor: "var(--accent)" }}
          />
          <input
            type="number"
            min={range.min}
            max={range.max}
            step={range.step}
            value={value === null ? "" : String(value)}
            disabled={disabled}
            aria-label={`${item.label}（数值）`}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") return;
              const n = Number(raw);
              if (!Number.isFinite(n)) return;
              updateContextDiet({ [item.key]: n } as Partial<ContextDietSettings>);
            }}
            onBlur={(e) => {
              // 失焦时把越界/空值碰回合法区间，避免留下非法设置
              const n = Number(e.target.value);
              const clamped = Number.isFinite(n) ? Math.min(range.max, Math.max(range.min, Math.round(n))) : range.min;
              updateContextDiet({ [item.key]: clamped } as Partial<ContextDietSettings>);
            }}
            style={{
              width: 62,
              flexShrink: 0,
              height: 24,
              padding: "0 6px",
              fontSize: 11.5,
              fontVariantNumeric: "tabular-nums",
              textAlign: "right",
              background: "var(--bg-selected)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-xs)",
              color: disabled ? "var(--text-dim)" : "var(--text)",
            }}
          />
        </div>
      </div>
    );
  };

  /** 0~100% 滑杆一行（标签 + 说明 + 滑杆 + 可输入的数字框），即时生效、不需确认。 */
  const glassSliderRow = (
    label: string,
    desc: string,
    value: number,
    onChange: (next: number) => void,
  ) => (
    <div style={{ padding: "8px 10px 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 12.5, fontWeight: 500, color: "var(--text)" }}>{label}</span>
          <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)", marginTop: 1 }}>{desc}</span>
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
        <input
          type="range"
          min={GLASS_OPACITY_MIN}
          max={GLASS_OPACITY_MAX}
          step={GLASS_OPACITY_STEP}
          value={value}
          aria-label={label}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ flex: 1, minWidth: 0, accentColor: "var(--accent)" }}
        />
        <input
          type="number"
          min={GLASS_OPACITY_MIN}
          max={GLASS_OPACITY_MAX}
          step={GLASS_OPACITY_STEP}
          value={String(value)}
          aria-label={`${label}（百分比）`}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return;
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            onChange(n);
          }}
          onBlur={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isFinite(n) ? n : GLASS_OPACITY_MAX);
          }}
          style={{
            width: 62,
            flexShrink: 0,
            height: 24,
            padding: "0 6px",
            fontSize: 11.5,
            fontVariantNumeric: "tabular-nums",
            textAlign: "right",
            background: "var(--bg-selected)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-xs)",
            color: "var(--text)",
          }}
        />
      </div>
    </div>
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
    borderRadius: "var(--radius-xs)",
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
        {showAgentLibrary ? (
          <AgentLibraryPanel onBack={() => setShowAgentLibrary(false)} />
        ) : (
        <>
        {sectionTitle(t("settings.session"))}
        {sessionRows.map(renderRow)}
        {contextDietRows.map(renderRow)}
        {contextDiet === null || contextDiet.enabled ? dietSliders.map(renderDietSlider) : null}
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
        {/* 背景样式选择 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
              {t("settings.glowStyle")}
            </span>
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, padding: "0 10px 10px", flexWrap: "wrap" }}>
          {GLOW_STYLE_IDS.map((id) => {
            const selected = glowStyle === id;
            const label = t(`settings.glowStyle${id.charAt(0).toUpperCase()}${id.slice(1)}`);
            return (
              <button
                key={id}
                type="button"
                onClick={() => setGlowStyle(id)}
                style={{
                  height: 26,
                  padding: "0 10px",
                  borderRadius: "var(--radius-xs)",
                  background: selected ? "var(--accent-soft)" : "var(--bg-hover)",
                  border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
                  color: selected ? "var(--accent-hover)" : "var(--text)",
                  cursor: "pointer",
                  fontSize: 11.5,
                  fontWeight: selected ? 550 : 400,
                  transition: "background 0.1s, color 0.1s",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        {/* 光晕强度拖动 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
              {t("settings.glowIntensity")}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
              {t("settings.glowIntensityDesc")}
            </span>
          </span>
          <input
            type="range"
            min={GLOW_INTENSITY_MIN}
            max={GLOW_INTENSITY_MAX}
            step={0.05}
            value={glowIntensity}
            onChange={(e) => setGlowIntensity(Number(e.target.value))}
            aria-label={t("settings.glowIntensity")}
            className="glow-intensity-slider"
            style={{
              width: 132,
              cursor: "pointer",
              accentColor: "var(--accent)",
            }}
          />
          <span
            style={{
              fontSize: 11,
              color: "var(--text-dim)",
              width: 36,
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {Math.round(glowIntensity * 100)}%
          </span>
        </div>
        {/* 桌面玻璃透明度：前景（玻璃卡）/ 背景（统一底板）两条滑杆 */}
        {glassSliderRow(
          t("settings.glassForeground"),
          t("settings.glassForegroundDesc"),
          glassForeground,
          setGlassForeground,
        )}
        {glassSliderRow(
          t("settings.glassBackground"),
          t("settings.glassBackgroundDesc"),
          glassBackground,
          setGlassBackground,
        )}
        </>
        )}

        {/* Accent color: preset palette + free-form picker */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
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
            onClick={() => {
              // 主题重置：主题色 + 玻璃透明度 + 背景底板 + 光晕强度一起回到默认值
              resetAccentColor();
              resetGlassOpacity();
              resetGlowIntensity();
            }}
            title={t("settings.resetAppearance")}
            aria-label={t("settings.resetAppearance")}
            style={{
              flexShrink: 0,
              height: 24,
              padding: "0 9px",
              background: "var(--bg-hover)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-xs)",
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
              borderRadius: "var(--radius-sm)",
              overflow: "hidden",
              cursor: "pointer",
              border: "1px solid var(--border)",
              background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
            }}
          >
            <input
              type="color"
              value={normalizeHex(customColor) ?? DEFAULT_ACCENT}
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
                  borderRadius: "var(--radius-sm)",
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
              borderRadius: "var(--radius-sm)",
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
        borderRadius: "var(--radius-md)",
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
          boxShadow: "var(--shadow-sm)",
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
function IconCompress() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9h16M4 15h16M9 4l3 5 3-5M9 20l3-5 3 5" />
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
function IconGlow() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
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
function IconLibrary() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="2" />
      <path d="M3 21v-4l4-4 3 3 4-4 5 5v4" />
      <circle cx="18" cy="5" r="1.5" />
      <circle cx="8" cy="15" r="1" />
      <path d="M12 12a3 3 0 1 1 0-6 3 3 0 0 1 0 6z" />
    </svg>
  );
}
