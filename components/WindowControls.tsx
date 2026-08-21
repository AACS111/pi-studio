"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";

/**
 * Electron-only window control buttons (— □ ×), wired to the main process via
 * IPC (see electron/main.cjs `pi-window-*` handlers). Rendered inside the
 * center top bar so the app has NO separate title-bar layer. Returns null when
 * not running inside Electron.
 */

interface PiElectronApi {
  isElectron?: boolean;
  window?: {
    minimize: () => void;
    toggleMaximize: () => Promise<boolean>;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizedChange: (listener: (maximized: boolean) => void) => () => void;
  };
}

const getElectronApi = (): PiElectronApi | undefined =>
  typeof window !== "undefined" ? (window as unknown as { piElectron?: PiElectronApi }).piElectron : undefined;

const BTN_STYLE: CSSProperties = {
  width: 46,
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  flexShrink: 0,
  transition: "background 0.12s, color 0.12s",
};

function ControlButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      style={BTN_STYLE}
      onMouseEnter={(e: MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.background = danger ? "#e81123" : "var(--bg-hover)";
        e.currentTarget.style.color = danger ? "#ffffff" : "var(--text)";
      }}
      onMouseLeave={(e: MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
    >
      {children}
    </button>
  );
}

export function WindowControls() {
  // 不能在渲染期间同步读 window（SSR 无 window → null；Electron 注入后有 → div），
  // 会导致 hydration mismatch（服务器 HTML 无 div，客户端有）。
  // 改为挂载后（useEffect）再读 API：SSR 与首次 hydration 都返回 null，再客户端补渲染。
  const [api, setApi] = useState<PiElectronApi | undefined>(undefined);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const a = getElectronApi();
    setApi(a);
    if (!a?.window) return;
    let alive = true;
    void a.window.isMaximized().then((m) => {
      if (alive) setIsMaximized(m);
    });
    const off = a.window.onMaximizedChange((m) => setIsMaximized(m));
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!api?.window) return null;

  return (
    <div style={{ display: "flex", height: "100%", flexShrink: 0, marginLeft: 2 }}>
      <ControlButton label="Minimize" onClick={() => api.window?.minimize()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </ControlButton>
      <ControlButton
        label={isMaximized ? "Restore" : "Maximize"}
        onClick={async () => {
          const m = await api.window?.toggleMaximize();
          if (m !== undefined) setIsMaximized(m);
        }}
      >
        {isMaximized ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="4" y="8" width="12" height="12" rx="1.5" />
            <path d="M8 8V4h12v12h-4" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="5" width="14" height="14" rx="1.5" />
          </svg>
        )}
      </ControlButton>
      <ControlButton label="Close" danger onClick={() => api.window?.close()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </ControlButton>
    </div>
  );
}
