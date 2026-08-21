"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PiUiExtension } from "@/lib/plugins/ui/types";
import { useDshClientPlugin, type SlotRegistration } from "./DshClientLoader";

/**
 * Pi Studio UI Extension Point — 前端宿主。
 *
 * - usePluginExtensions(): 拉取 /api/plugins/ui 的扩展列表（ActivityBar rail 用）。
 * - pluginIconNode(): 内置图标名 → SVG children（服务端不传 ReactNode，只传名字）。
 * - PluginExtensionPanel: 渲染单个扩展的面板内容。
 *   Pi 原生扩展（origin !== "dsh" 或无 client）显示元数据占位；
 *   DSH client 插件由 dsh-client-adapter 动态加载（B2 阶段接入）。
 */

/* ── 内置图标集合（与服务端 PiUiSidebarEntry.icon 对应） ── */

const ICON_PATHS: Record<string, ReactNode> = {
  board: (
    <>
      <rect x="3" y="3" width="6" height="14" rx="1.5" />
      <rect x="11" y="3" width="6" height="9" rx="1.5" />
      <rect x="19" y="3" width="2" height="16" rx="1" />
    </>
  ),
  git: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M6 8.5v7M18 8.5a9 9 0 0 1-3 7" />
    </>
  ),
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>
  ),
  browser: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </>
  ),
  skin: (
    <>
      <path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" />
    </>
  ),
  stats: (
    <>
      <line x1="4" y1="20" x2="20" y2="20" />
      <rect x="6" y="11" width="3" height="6" rx="0.5" />
      <rect x="11" y="7" width="3" height="10" rx="0.5" />
      <rect x="16" y="4" width="3" height="13" rx="0.5" />
    </>
  ),
  ssh: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l4 3-4 3" />
      <path d="M13 15h4" />
    </>
  ),
  remote: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M9 9h6M9 12h4M9 15h5" />
    </>
  ),
  puzzle: (
    <>
      <path d="M9 3a2 2 0 0 1 2 2v0a2 2 0 0 0 2 2h5a1 1 0 0 1 1 1v3a2 2 0 0 0 2 2v0a2 2 0 0 1 0 4v0a2 2 0 0 0-2 2v3a1 1 0 0 1-1 1h-3a2 2 0 0 0-2-2v0a2 2 0 0 1-4 0v0a2 2 0 0 0-2 2H6a1 1 0 0 1-1-1v-3a2 2 0 0 0-2-2v0a2 2 0 0 1 0-4v0a2 2 0 0 0 2-2V6a1 1 0 0 1 1-1h3z" />
    </>
  ),
  default: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M8 12h8M12 8v8" />
    </>
  ),
};

export function pluginIconNode(icon?: string): ReactNode {
  const name = icon && ICON_PATHS[icon] ? icon : "default";
  return ICON_PATHS[name];
}

/* ── 扩展列表 hook ── */

export interface PluginExtensionsState {
  extensions: PiUiExtension[];
  loading: boolean;
}

export function usePluginExtensions(): PluginExtensionsState {
  const [extensions, setExtensions] = useState<PiUiExtension[]>([]);
  const [loading, setLoading] = useState(true);
  const reqRef = useRef(0);

  const reload = useCallback(async () => {
    const id = ++reqRef.current;
    try {
      const res = await fetch("/api/plugins/ui", { cache: "no-store" });
      const d = (await res.json().catch(() => ({}))) as { extensions?: PiUiExtension[] };
      if (id === reqRef.current && Array.isArray(d.extensions)) {
        setExtensions(d.extensions);
      }
    } catch {
      // keep last known state
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // 轻量轮询：插件安装/卸载后扩展列表会变（低频，5s）。
    const timer = window.setInterval(() => void reload(), 5000);
    return () => window.clearInterval(timer);
  }, [reload]);

  return { extensions, loading };
}

/* ── 单个扩展面板 ── */

function OriginBadge({ origin }: { origin: PiUiExtension["origin"] }) {
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    pi: { label: "PI", bg: "rgba(34,197,94,0.12)", fg: "#16a34a" },
    dsh: { label: "DSH", bg: "rgba(99,102,241,0.12)", fg: "rgba(99,102,241,0.9)" },
    mcp: { label: "MCP", bg: "rgba(234,179,8,0.12)", fg: "#b45309" },
  };
  const c = map[origin] ?? map.pi;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.5,
        padding: "2px 7px",
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
      }}
    >
      {c.label}
    </span>
  );
}

export function PluginExtensionPanel({ extension }: { extension: PiUiExtension }) {
  const { t } = useI18n();
  const hasDshClient = extension.origin === "dsh" && extension.client != null;
  const dshClient = useDshClientPlugin(hasDshClient ? extension : null);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{extension.title}</span>
        <OriginBadge origin={extension.origin} />
        <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: "auto" }}>{extension.pluginId}</span>
      </div>

      <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.7 }}>
        {extension.description && <p style={{ margin: "0 0 12px" }}>{extension.description}</p>}

        {hasDshClient ? (
          <div>
            {dshClient.loading && <p style={{ margin: 0 }}>{t("pluginHost.dshClientLoading")}</p>}
            {dshClient.error && (
              <div
                style={{
                  border: "1px dashed var(--border)",
                  borderRadius: 10,
                  padding: 14,
                  background: "var(--bg-panel)",
                  color: "var(--text-muted)",
                }}
              >
                <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
                  {t("pluginHost.dshClientPending")}
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{dshClient.error}</div>
              </div>
            )}
            {!dshClient.loading && !dshClient.error && dshClient.slots.length === 0 && (
              <p style={{ margin: 0 }}>{t("pluginHost.dshClientNoSlots")}</p>
            )}
            {dshClient.slots.map((slot) => {
              return (
                <DswCssScope key={slot.id} slotName={slot.slotName}>
                  <SlotRender slot={slot} />
                </DswCssScope>
              );
            })}
          </div>
        ) : (
          <p style={{ margin: 0 }}>{t("pluginHost.nativePlaceholder")}</p>
        )}
      </div>
    </div>
  );
}

/**
 * DSH slot 渲染器：宿主调用 descriptor.inject() 取组件 props，
 * 把 props.hooks 的 SnapshotStore 包成 useXxx hooks（useSyncExternalStore），
 * 并补 DSH 字典翻译函数 t（slot.locale 命名空间 + Pi 当前语言）。
 *
 * DSH slot 协议（dsh-client-ui-slots）：组件签名为 (props)，props 由
 * 宿主在渲染时注入 —— 跳过 inject() 会让组件读 undefined.getPrefs() 崩掉。
 */
function SlotRender({ slot }: { slot: SlotRegistration }) {
  const { locale } = useI18n();

  // 所有 hooks 无条件先调用（rules-of-hooks：select 判断/条件渲染放底部）。

  // inject(owner?) 取组件 props（turnTail 的 inject(sessionId)；无 owner 传 undefined）。
  const props = useMemo(() => {
    try {
      return slot.inject ? (slot.inject(undefined) ?? {}) : {};
    } catch {
      return {};
    }
  }, [slot]);

  // hooks: { liveStatsSettingsCard: store } → props.useLiveStatsSettingsCard(selector)。
  // hook 函数在组件体内被调用（LiveStatsSettingsCard 顶层），是合法的 hook 调用点。
  const hookProps = useMemo(() => {
    const hooks = (props.hooks ?? {}) as Record<
      string,
      { getSnapshot: () => unknown; subscribe: (cb: () => void) => () => void }
    >;
    const out: Record<string, unknown> = {};
    for (const [name, store] of Object.entries(hooks)) {
      const hookName = `use${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      const useStoreHook = (selector: (s: unknown) => unknown) =>
        // 运行时是合法 hook 调用点：该函数作为 props 传给 DSH 组件，
        // 在组件体内顶层调用（LiveStatsSettingsCard 的 useLiveStatsSettingsCard）。
        // 第三个参数 getServerSnapshot：slot 面板若被 SSR 预渲染也不报错。
        useSyncExternalStore(
          store.subscribe,
          () => selector(store.getSnapshot()),
          () => selector(store.getSnapshot()),
        );
      out[hookName] = useStoreHook;
    }
    // conversation.composer.dock 等 conversation seat 的标准 kit 提供 useProjection
    // （输入内容投影 hook）。Pi 未实现 conversation 服务 → 提供空投影（返回
    // undefined，组件读 ?.tokensPerSecond 显示空，不崩）。
    if (!("useProjection" in out)) {
      out.useProjection = () => undefined;
    }
    return out;
  }, [props]);

  // DSH 字典翻译（slot.locale ns + 当前语言，找不到回退 en / key 本身）。
  const t = useCallback(
    (key: string) => {
      if (!slot.locale) return key;
      const dictApi = (window as unknown as { __piDshLocale?: { dict: (ns: string, lang: string) => Record<string, string> | undefined } })
        .__piDshLocale;
      const lang = locale.startsWith("zh") ? "zh" : "en";
      const dict = dictApi?.dict(slot.locale, lang) ?? dictApi?.dict(slot.locale, "en");
      return dict?.[key] ?? key;
    },
    [slot.locale, locale],
  );

  // ── 底部：selective slot 判断（hook 之后，可安全 return null）──
  if (slot.select) {
    let selected: unknown = null;
    try {
      selected = slot.select(undefined);
    } catch {
      selected = null;
    }
    if (selected === null) return null;
    const Comp = slot.component;
    // select 返回值注入组件（turnTail：select 返回文件 paths 数组，
    // 组件 SidebarProducedFiles 用 props.matched 渲染）。
    return <Comp {...props} matched={selected} {...hookProps} t={t} />;
  }

  const Comp = slot.component;
  return <Comp {...props} {...hookProps} t={t} />;
}

/**
 * DSH 插件 CSS 作用域容器：注入 --dsw-* 变量（映射到 Pi 主题）并标记 slot 名。
 * DSH client 插件的 CSS 引用大量 --dsw-alias-* 变量（bg-layer/border/label/brand），
 * Pi 没有 → 渲染出来无底色/无边框。这里在渲染容器上提供映射，插件零改动。
 */
function DswCssScope({ slotName, children }: { slotName: string; children: ReactNode }) {
  const dswVars: Record<string, string> = {
    "--dsw-alias-bg-layer-1": "var(--bg)",
    "--dsw-alias-bg-layer-2": "var(--bg)",
    "--dsw-alias-bg-layer-3": "var(--bg-panel)",
    "--dsw-alias-bg-module-platform": "var(--bg-hover)",
    "--dsw-alias-bg-module-hover": "var(--bg-hover)",
    "--dsw-alias-border-l1": "var(--border)",
    "--dsw-alias-border-l2": "var(--border)",
    "--dsw-alias-label-primary": "var(--text)",
    "--dsw-alias-label-secondary": "var(--text-muted)",
    "--dsw-alias-label-tertiary": "var(--text-dim)",
    "--dsw-alias-label-dimmed": "var(--border)",
    "--dsw-alias-label-error": "#ef4444",
    "--dsw-alias-brand-primary": "var(--accent)",
    "--dsw-alias-brand-secondary": "var(--accent)",
    "--dsw-alias-state-warn-primary": "#f59e0b",
    "--dsw-alias-state-error-primary": "#ef4444",
    "--dsw-alias-state-ok-primary": "#16a34a",
    "--dsw-alias-scrollbar-thumb": "var(--border)",
  };
  return (
    <div
      data-dsh-slot={slotName}
      style={{ ...dswVars, color: "var(--text)", fontSize: 13, minWidth: 0 }}
    >
      {children}
    </div>
  );
}
