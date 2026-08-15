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
  const api = getElectronApi();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!api?.window) return;
    let alive = true;
    void api.window.isMaximized().then((m) => {
      if (alive) setIsMaximized(m);
    });
    const off = api.window.onMaximizedChange((m) => setIsMaximized(m));
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
