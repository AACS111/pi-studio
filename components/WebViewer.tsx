"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { normalizeUserUrl } from "@/lib/browser-proxy";

declare global {
  interface Window {
    piElectron?: {
      isElectron?: boolean;
      openUploadsDir?: () => Promise<{ ok: boolean; error?: string }>;
      webview?: {
        create: (tabId: string) => Promise<void>;
        destroy: (tabId: string) => Promise<void>;
        setVisible: (tabId: string, visible: boolean) => void;
        setBounds: (tabId: string, bounds: { x: number; y: number; width: number; height: number }) => void;
        navigate: (tabId: string, url: string) => Promise<{ url: string | null; title: string | null }>;
        back: (tabId: string) => Promise<{ moved: boolean }>;
        forward: (tabId: string) => Promise<{ moved: boolean }>;
        reload: (tabId: string) => Promise<{ ok: boolean }>;
        getInfo: (tabId: string) => Promise<{ url: string | null; title: string | null }>;
        onStatus: (listener: (info: { tabId: string; url: string | null; title: string | null }) => void) => () => void;
        onNavigate: (listener: (info: { tabId: string; url: string | null; title: string | null }) => void) => () => void;
      };
    };
  }
}

interface Props {
  /** Stable id of this web tab (used as the Electron WebContentsView key). */
  tabId: string;
  /** URL the tab was opened with (agent marker). Null = fresh tab. */
  initialUrl: string | null;
  /** Reported on every manual navigation / address-bar submit. */
  onNavigate?: (url: string | null) => void;
  /** Focus the address bar when the tab becomes active and is still empty. */
  active?: boolean;
}

function hostLabel(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 计算镜像区域的实际可见尺寸。
 *
 * 右侧面板（.right-panel-container）收起时容器 width:0，但内部内容被 CSS 保持固定
 * 宽度（.right-panel-container > * { width: 固定值 }）——内层 getBoundingClientRect()
 * 永远返回全宽，检测不到收起。所以必须看容器：class 是否 right-panel-closed / 是否
 * 移出视口 / 裁剪后的有效宽度。原生 WebContentsView 是 DOM 外的覆盖层，不随 CSS 裁剪，
 * 收起时若继续用旧 bounds 就会悬浮在聊天区上方。
 */
function visibleFrameSize(el: HTMLElement): { w: number; h: number; visible: boolean } {
  const r = el.getBoundingClientRect();
  const container = el.closest(".right-panel-container");
  const panel = container ? container.getBoundingClientRect() : r;
  const closed = container ? container.classList.contains("right-panel-closed") : false;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const onScreen = panel.right > 0 && panel.left < vw && panel.bottom > 0 && panel.top < vh;
  const effW = Math.min(r.width, panel.width);
  const visible = !closed && onScreen && effW >= 40 && r.height >= 40;
  return {
    w: visible ? Math.round(Math.min(effW, r.width)) : 0,
    h: visible ? Math.round(r.height) : 0,
    visible,
  };
}

/**
 * 右侧浏览器面板（仅 Electron 桌面模式）。
 *
 * 右侧浏览器由 Electron 主进程的 WebContentsView 提供（electron/main.cjs + bridge.cjs），
 * 语义控制接口（/snapshot /execute 等）也只有该模式可用。npm run dev 纯浏览器模式下
 * 无原生视图、无控制桥——面板只显示「仅 Electron 支持」提示，不渲染 iframe/镜像。
 */
export function WebViewer({ tabId, initialUrl, active, onNavigate }: Props) {
  const { t } = useI18n();
  const nativeApi = typeof window !== "undefined" ? window.piElectron?.webview : undefined;
  const nativeMode = Boolean(nativeApi);
  const [nativeReady, setNativeReady] = useState(false);
  const [inputValue, setInputValue] = useState(initialUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ---- 原生模式状态（Electron WebContentsView） ----
  const [consoleUrl, setConsoleUrl] = useState<string | null>(null);
  const [consoleTitle, setConsoleTitle] = useState<string | null>(null);
  const [consoleOnline, setConsoleOnline] = useState(false);
  const frameAreaRef = useRef<HTMLDivElement | null>(null);

  // ---- 同步原生 WebContentsView 的可见性 / 位置 / 尺寸（ResizeObserver） ----
  // 原生视图是 DOM 外的覆盖层，不随面板 CSS 自动收窄/变宽，必须按镜像区域的
  // 实际可见尺寸显式 setBounds。观察容器（而非内层：收起时 CSS 保持内层固定
  // 宽度，仅容器 width→0 裁剪，观察内层永远等不到 resize 事件），在拖拽调宽、
  // 开合面板动画、最大化、窗口缩放等所有尺寸变化时实时更新 bounds；面板收起
  // 或过窄时隐藏视图，避免它以最后一份 bounds 悬浮在聊天区上方。
  useEffect(() => {
    if (!nativeApi || !nativeReady) return;
    if (!active) {
      nativeApi.setVisible(tabId, false);
      return;
    }
    const el = frameAreaRef.current;
    if (!el) return;
    const sync = () => {
      const vs = visibleFrameSize(el);
      if (!vs.visible) {
        nativeApi.setVisible(tabId, false);
        return;
      }
      nativeApi.setVisible(tabId, true);
      nativeApi.setBounds(tabId, {
        x: Math.round(el.getBoundingClientRect().left),
        y: Math.round(el.getBoundingClientRect().top),
        width: vs.w,
        height: vs.h,
      });
    };
    sync();
    const observeTarget = el.closest(".right-panel-container") || el;
    const ro = new ResizeObserver(sync);
    ro.observe(observeTarget);
    return () => ro.disconnect();
  }, [active, nativeApi, nativeReady, tabId]);

  // ---- Electron 原生模式：WebContentsView 生命周期 + 状态同步 ----
  useEffect(() => {
    if (!nativeApi) {
      setNativeReady(false);
      return;
    }
    let disposed = false;
    setNativeReady(false);
    void nativeApi.create(tabId).then(() => {
      if (disposed) return;
      setNativeReady(true);
    }).catch(() => {
      if (disposed) return;
      setNativeReady(false);
      setError(t("browser.consoleNotRunning"));
    });
    return () => {
      disposed = true;
      void nativeApi.destroy(tabId);
    };
  }, [nativeApi, t, tabId]);

  useEffect(() => {
    if (!nativeApi || !nativeReady) return;
    const onStatus = (info: { tabId: string; url: string | null; title: string | null }) => {
      if (info.tabId !== tabId) return;
      setConsoleOnline(true);
      setConsoleUrl(info.url);
      setConsoleTitle(info.title);
    };
    const onNavigated = (info: { tabId: string; url: string | null; title: string | null }) => {
      if (info.tabId !== tabId) return;
      setConsoleOnline(true);
      setConsoleUrl(info.url);
      setConsoleTitle(info.title);
      if (info.url && info.url !== inputValue && document.activeElement !== inputRef.current) {
        setInputValue(info.url);
      }
      onNavigate?.(info.url);
    };
    const offStatus = nativeApi.onStatus(onStatus);
    const offNavigate = nativeApi.onNavigate(onNavigated);
    void nativeApi.getInfo(tabId).then((info) => {
      setConsoleOnline(true);
      setConsoleUrl(info.url);
      setConsoleTitle(info.title);
    }).catch(() => {});
    return () => {
      offStatus();
      offNavigate();
    };
  }, [nativeApi, nativeReady, tabId, inputValue, onNavigate]);

  // 原生模式的导航：直接驱动 WebContentsView
  const consoleNavigate = useCallback(async (raw: string): Promise<boolean> => {
    const url = normalizeUserUrl(raw);
    if (!url) {
      setError(t("browser.invalidUrl"));
      return false;
    }
    setError(null);
    setInputValue(url);
    try {
      if (nativeApi) {
        const info = await nativeApi.navigate(tabId, url);
        setConsoleOnline(true);
        setConsoleUrl(info.url ?? url);
        setConsoleTitle(info.title ?? null);
        onNavigate?.(url);
        return true;
      }
      setError(t("browser.consoleNotRunning"));
      return false;
    } catch {
      setError(t("browser.consoleNotRunning"));
      return false;
    }
  }, [nativeApi, onNavigate, t, tabId]);

  // agent marker 推送 / 打开标签带入的 URL：标签激活时导航一次原生浏览器。
  // 仅当处于激活态才执行，避免隐藏标签偷偷把浏览器导航走。
  const navigatedInitialRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !initialUrl) return;
    if (nativeMode && !nativeReady) return;
    if (navigatedInitialRef.current === initialUrl) return;
    setInputValue(initialUrl);
    void consoleNavigate(initialUrl).then((ok) => {
      if (ok) navigatedInitialRef.current = initialUrl;
    });
  }, [active, initialUrl, consoleNavigate, nativeMode, nativeReady]);

  const consoleAction = useCallback(async (action: string) => {
    try {
      if (nativeApi) {
        if (action === "back") await nativeApi.back(tabId);
        else if (action === "forward") await nativeApi.forward(tabId);
        else if (action === "reload") await nativeApi.reload(tabId);
        return;
      }
      setError(t("browser.consoleNotRunning"));
    } catch {
      setError(t("browser.consoleNotRunning"));
    }
  }, [nativeApi, t, tabId]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    void consoleNavigate(inputValue);
  }, [consoleNavigate, inputValue]);

  const handleBack = useCallback(() => {
    void consoleAction("back");
  }, [consoleAction]);

  const handleForward = useCallback(() => {
    void consoleAction("forward");
  }, [consoleAction]);

  const handleReload = useCallback(() => {
    void consoleAction("reload");
  }, [consoleAction]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "var(--bg)" }}>
      {/* Toolbar: back / forward / reload / address bar / go */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "4px 8px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={handleBack}
          title={t("browser.back")}
          aria-label={t("browser.back")}
          style={iconButtonStyle}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleForward}
          title={t("browser.forward")}
          aria-label={t("browser.forward")}
          style={iconButtonStyle}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleReload}
          title={t("browser.reload")}
          aria-label={t("browser.reload")}
          style={iconButtonStyle}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>

        <form
          style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
          onSubmit={handleSubmit}
        >
          <div style={{ flex: 1, display: "flex", alignItems: "center", minWidth: 0, position: "relative" }}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ position: "absolute", left: 8, color: "var(--text-dim)", pointerEvents: "none" }}
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => { setInputValue(e.target.value); setError(null); }}
              onFocus={(e) => e.currentTarget.select()}
              placeholder={t("browser.addressPlaceholder")}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              aria-label={t("browser.addressPlaceholder")}
              style={{
                width: "100%",
                height: 28,
                padding: "0 8px 0 26px",
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text)",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                outline: "none",
              }}
            />
          </div>
          <button
            type="submit"
            title={t("browser.go")}
            aria-label={t("browser.go")}
            style={{ ...iconButtonStyle, flexShrink: 0 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </form>

        {consoleUrl && (
          <span
            title={consoleUrl}
            style={{
              flexShrink: 0,
              fontSize: 11,
              color: consoleOnline ? "var(--text-dim)" : "#f87171",
              fontFamily: "var(--font-mono)",
              maxWidth: 140,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {hostLabel(consoleUrl)}
          </span>
        )}
      </div>

      {/* Frame */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--bg)" }}>
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "var(--bg)",
            outline: "none",
          }}
        >
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 10px",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-panel)",
              fontSize: 11,
              color: "var(--text-muted)",
              flexWrap: "nowrap",
            }}
          >
            <span style={{ flexShrink: 0, color: nativeMode ? "#4ade80" : "#f87171" }}>
              ● {nativeMode ? t("browser.liveStatus") : t("browser.consoleNotRunning")}
            </span>
            <span style={{ flexShrink: 0 }}>
              {nativeMode ? "原生浏览器 (WebContentsView)" : t("browser.electronOnly")}
            </span>
            {nativeMode && consoleTitle && (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={consoleTitle}>
                {consoleTitle}
              </span>
            )}
            {nativeMode && consoleUrl && (
              <a
                href={consoleUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ marginLeft: "auto", color: "var(--text-muted)", flexShrink: 0, textDecoration: "none" }}
              >
                ↗
              </a>
            )}
          </div>
          <div ref={frameAreaRef} style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--bg)" }}>
            {nativeMode ? (
              <div aria-hidden="true" style={{ height: "100%", minHeight: 0 }} />
            ) : (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "#f87171", fontSize: 12, textAlign: "center" }}>
                {t("browser.consoleNotRunning")}
              </div>
            )}
          </div>
        </div>
        {error && (
          <div
            role="alert"
            style={{
              position: "absolute",
              bottom: 12,
              left: "50%",
              transform: "translateX(-50%)",
              maxWidth: "90%",
              padding: "6px 12px",
              background: "rgba(220,38,38,0.12)",
              border: "1px solid rgba(220,38,38,0.35)",
              borderRadius: 6,
              color: "#dc2626",
              fontSize: 12,
              zIndex: 20,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  padding: 0,
  background: "transparent",
  border: "none",
  borderRadius: 6,
  color: "var(--text-muted)",
  cursor: "pointer",
  transition: "background 0.12s, color 0.12s",
};
