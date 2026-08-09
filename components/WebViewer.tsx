"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { normalizeUserUrl } from "@/lib/browser-proxy";

// 实时镜像面板上需要转发为 CDP 按键事件的特殊键（其余单字符走 Input.insertText）
const SPECIAL_KEYS = new Set([
  "Enter", "Escape", "Tab", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "F5",
]);

interface Props {
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
 * 右侧浏览器面板：Agent 控制台（browser-use 侧车实时镜像）。
 *
 * 只保留 Agent 打开网页的方式——agent 通过 /api/browser marker 推送 URL，
 * 或用户在地址栏输入，面板都直接驱动本地 sidecar 的真实浏览器
 * （127.0.0.1:17865）。不再提供 iframe 代理的「网页」预览模式。
 */
export function WebViewer({ initialUrl, active, onNavigate }: Props) {
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState(initialUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ---- Agent 控制台（browser-use 侧车镜像）状态 ----
  // 实时镜像：SSE 推流帧（/screencast），回退到 1.5s 截图轮询；可点/拖/滚/键盘直接驱动真实浏览器
  const [consoleUrl, setConsoleUrl] = useState<string | null>(null);
  const [consoleTitle, setConsoleTitle] = useState<string | null>(null);
  const [liveFrame, setLiveFrame] = useState<string | null>(null);
  const [consoleOnline, setConsoleOnline] = useState(false);
  const consolePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameImgRef = useRef<HTMLImageElement | null>(null);
  const consolePaneRef = useRef<HTMLDivElement | null>(null);
  const frameAreaRef = useRef<HTMLDivElement | null>(null);
  // 拖拽状态（左/中键按下后进入拖拽，松开结束）
  const dragStateRef = useRef<{ active: boolean; button: "left" | "right" | "middle"; lastMove: number }>({
    active: false, button: "left", lastMove: 0,
  });
  // 双击检测（同位置 350ms 内第二次按下 → 双击）
  const lastClickRef = useRef<{ t: number; x: number; y: number } | null>(null);
  // 镜像区域尺寸（CSS px）+ 用户屏幕 DPR —— 传给侧车把浏览器 viewport 设成与面板一致，
  // 截图 1:1 像素、不变形、点击坐标直接映射。
  const [frameSize, setFrameSize] = useState<{ w: number; h: number; dpr: number } | null>(null);

  // ---- 控制台模式：URL/标题轮询（帧画面走 SSE 推流，见下方 effect） ----
  useEffect(() => {
    if (!active) {
      if (consolePollRef.current) {
        clearInterval(consolePollRef.current);
        consolePollRef.current = null;
      }
      return;
    }
    const poll = async () => {
      try {
        const urlRes = await fetch("/api/browser/control/url");
        if (!urlRes.ok) {
          setConsoleOnline(false);
          return;
        }
        const info = (await urlRes.json()) as { url?: string | null; title?: string | null };
        setConsoleOnline(true);
        setConsoleUrl(info.url ?? null);
        setConsoleTitle(info.title ?? null);
        // 轮询只同步地址栏当用户没在编辑时（聚焦输入时若覆盖会吞掉用户正在打的字）
        if (info.url && info.url !== inputValue && document.activeElement !== inputRef.current) {
          setInputValue(info.url);
        }
      } catch {
        setConsoleOnline(false);
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    consolePollRef.current = timer;
    return () => {
      if (consolePollRef.current) {
        clearInterval(consolePollRef.current);
        consolePollRef.current = null;
      }
    };
  }, [active, inputValue]);

  // ---- 测量镜像区域尺寸（ResizeObserver），尺寸/DPR 变化时重建 SSE ----
  useEffect(() => {
    if (!active) return;
    const el = frameAreaRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return;
      const next = { w: Math.round(r.width), h: Math.round(r.height), dpr: window.devicePixelRatio || 1 };
      setFrameSize((prev) => {
        if (
          prev
          && Math.abs(prev.w - next.w) <= 1
          && Math.abs(prev.h - next.h) <= 1
          && prev.dpr === next.dpr
        ) return prev;
        return next;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);

  // ---- SSE 实时帧流（侧车 /screencast），失败则退化为截图轮询 ----
  useEffect(() => {
    if (!active) {
      setLiveFrame(null);
      return;
    }
    const ctrl = new AbortController();
    let disposed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const startFramePolling = () => {
      if (pollTimer || disposed) return;
      pollTimer = setInterval(async () => {
        try {
          const r = await fetch("/api/browser/control/screenshot?json=1", { signal: ctrl.signal });
          const j = (await r.json()) as { png_base64?: string };
          if (j.png_base64) setLiveFrame(`data:image/png;base64,${j.png_base64}`);
        } catch { /* 侧车离线 */ }
      }, 1500);
    };

    // 把面板尺寸传给侧车：浏览器 viewport 与面板 1:1，截图按 w*dpr × h*dpr 像素输出
    const screencastUrl = frameSize
      ? `/api/browser/control/screencast?w=${frameSize.w}&h=${frameSize.h}&dpr=${frameSize.dpr}`
      : "/api/browser/control/screencast";

    const sseLoop = async () => {
      try {
        const res = await fetch(screencastUrl, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`screencast HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (disposed) return;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            // 只接受纯帧事件：event: error / JSON 载荷不是截图，直接忽略——
            // 否则会把 {"message": ...} 拼成非法 data URL，图片解码失败 → 白屏 + alt 文字
            const isErrorEvent = block.split("\n").some((l) => l.startsWith("event: error"));
            const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
            if (!isErrorEvent && dataLine) {
              const payload = dataLine.slice(6).trim();
              if (payload && !payload.startsWith("{")) setLiveFrame(`data:image/jpeg;base64,${payload}`);
            }
          }
        }
      } catch {
        /* SSE 不可用/中断 → 退化轮询 */
      }
      if (!disposed) startFramePolling();
    };
    void sseLoop();

    return () => {
      disposed = true;
      ctrl.abort();
      if (pollTimer) clearInterval(pollTimer);
      setLiveFrame(null);
    };
  }, [active, frameSize]);

  // 控制台模式的导航：直接驱动侧车浏览器
  const consoleNavigate = useCallback(async (raw: string) => {
    const url = normalizeUserUrl(raw);
    if (!url) {
      setError(t("browser.invalidUrl"));
      return;
    }
    setError(null);
    setInputValue(url);
    try {
      const res = await fetch("/api/browser/control/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        setError(t("browser.consoleNotRunning"));
        return;
      }
      onNavigate?.(url);
    } catch {
      setError(t("browser.consoleNotRunning"));
    }
  }, [onNavigate, t]);

  // agent marker 推送 / 打开标签带入的 URL：标签激活时导航一次侧车。
  // 仅当处于激活态才执行，避免隐藏标签偷偷把侧车浏览器导航走。
  const navigatedInitialRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !initialUrl) return;
    if (navigatedInitialRef.current === initialUrl) return;
    navigatedInitialRef.current = initialUrl;
    setInputValue(initialUrl);
    void consoleNavigate(initialUrl);
  }, [active, initialUrl, consoleNavigate]);

  const consoleAction = useCallback(async (action: string) => {
    try {
      const res = await fetch(`/api/browser/control/${action}`, { method: "POST" });
      if (!res.ok) setError(t("browser.consoleNotRunning"));
    } catch {
      setError(t("browser.consoleNotRunning"));
    }
  }, [t]);

  // ---- 实时镜像：把面板上的鼠标/键盘事件注入真实浏览器（CDP Input 域） ----
  const sendInput = useCallback(async (body: Record<string, unknown>) => {
    try {
      await fetch("/api/browser/control/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch { /* 侧车离线时忽略，静默 */ }
  }, []);

  /** 面板坐标 → 浏览器 viewport 坐标。
   *  现在浏览器 viewport 被设成与面板 1:1（Emulation.setDeviceMetricsOverride），
   *  所以直接取相对图片左上角的 CSS px 即可，无需缩放换算。 */
  const toViewport = useCallback((clientX: number, clientY: number) => {
    const img = frameImgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.min(Math.max(0, Math.round(clientX - rect.left)), Math.round(rect.width) - 1),
      y: Math.min(Math.max(0, Math.round(clientY - rect.top)), Math.round(rect.height) - 1),
    };
  }, []);

  const handleFramePointerDown = useCallback((e: React.PointerEvent) => {
    const pt = toViewport(e.clientX, e.clientY);
    if (!pt) return;
    const btn = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    if (btn === "right") {
      // 右键：按下+释放，让页面弹出自己的上下文菜单
      e.preventDefault();
      void sendInput({ type: "click", x: pt.x, y: pt.y, button: "right", clickCount: 1 });
      return;
    }
    // 双击检测（350ms 内同位置第二次按下 → clickCount 2，触发 canvas 单元格编辑）
    let clickCount = 1;
    const now = Date.now();
    if (lastClickRef.current
      && now - lastClickRef.current.t < 350
      && Math.abs(lastClickRef.current.x - pt.x) < 8
      && Math.abs(lastClickRef.current.y - pt.y) < 8) {
      clickCount = 2;
      lastClickRef.current = null;
    } else {
      lastClickRef.current = { t: now, x: pt.x, y: pt.y };
    }
    // 左键/中键：只按下不释放，进入拖拽状态（拖动才能多选/拖拽单元格）
    dragStateRef.current = { active: true, button: btn, lastMove: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    void sendInput({ type: "press", x: pt.x, y: pt.y, button: btn, clickCount });
  }, [sendInput, toViewport]);

  const handleFramePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag.active) return;
    // 节流：~40Hz 上限，避免高刷鼠标事件打爆请求队列
    const now = performance.now();
    if (now - drag.lastMove < 25) return;
    drag.lastMove = now;
    const pt = toViewport(e.clientX, e.clientY);
    if (!pt) return;
    // 携带按键状态掩码（CDP mouseMoved 需要知道正按着哪个键才能驱动 canvas 拖拽）
    void sendInput({
      type: "move", x: pt.x, y: pt.y,
      buttons: drag.button === "right" ? 2 : drag.button === "middle" ? 4 : 1,
    });
  }, [sendInput, toViewport]);

  const handleFramePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag.active) return;
    drag.active = false;
    const pt = toViewport(e.clientX, e.clientY);
    if (pt) void sendInput({ type: "release", x: pt.x, y: pt.y, button: drag.button, clickCount: 1 });
  }, [sendInput, toViewport]);

  // 面板上禁用浏览器默认右键菜单：右键已转发为真实浏览器的右键
  const handleFrameContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // 滚轮必须用原生监听（React 的 onWheel 在根节点是被动监听，preventDefault 无效）
  useEffect(() => {
    const el = consolePaneRef.current;
    if (!el || !active) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const pt = toViewport(e.clientX, e.clientY) ?? { x: 0, y: 0 };
      void sendInput({ type: "scroll", x: pt.x, y: pt.y, delta_y: Math.round(e.deltaY) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [active, sendInput, toViewport]);

  const handleFrameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      void sendInput({ type: "key", key: e.key });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // 普通字符直接插入到浏览器当前聚焦元素（Input.insertText，支持中文）
      void sendInput({ type: "type", text: e.key });
    }
  }, [sendInput]);

  // 侧车在线时自动聚焦镜像面板，让键盘直接打到浏览器上
  useEffect(() => {
    if (active && consoleOnline) {
      consolePaneRef.current?.focus({ preventScroll: true });
    }
  }, [active, consoleOnline]);

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
          ref={consolePaneRef}
          tabIndex={0}
          onKeyDown={handleFrameKeyDown}
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "var(--bg)",
            outline: "none",
            userSelect: "none",
            touchAction: "none",
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
            <span style={{ flexShrink: 0, color: "#4ade80" }}>● {t("browser.liveStatus")}</span>
            <span style={{ flexShrink: 0 }}>{t("browser.consoleStatus")}</span>
            {consoleTitle && (
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={consoleTitle}>
                {consoleTitle}
              </span>
            )}
            <a
              href={consoleUrl ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: "auto", color: "var(--text-muted)", flexShrink: 0, textDecoration: "none" }}
            >
              ↗
            </a>
          </div>
          <div ref={frameAreaRef} style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--bg)" }}>
            {consoleOnline ? (
              liveFrame ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  ref={frameImgRef}
                  src={liveFrame}
                  alt={t("browser.consoleScreenshot")}
                  draggable={false}
                  onPointerDown={handleFramePointerDown}
                  onPointerMove={handleFramePointerMove}
                  onPointerUp={handleFramePointerUp}
                  onPointerCancel={handleFramePointerUp}
                  onContextMenu={handleFrameContextMenu}
                  style={{ display: "block", width: "100%", height: "100%", margin: 0, cursor: "crosshair" }}
                />
              ) : (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
                  {t("browser.consoleLoading")}
                </div>
              )
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
