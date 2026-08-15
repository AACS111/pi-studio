"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";

/** First-level capability entries (一级导航). File is deliberately NOT here —
 *  the file explorer lives in the second column. */
export type Activity = "sessions" | "skills" | "terminal" | "settings";

interface ActivityItem {
  id: Activity;
  titleKey: string;
  icon: (active: boolean) => ReactNode;
}

const RAIL_WIDTH = 68;

/* ── Custom tooltip (replaces the native `title` tooltip) ────────────────
 * Dark pill to the right of the icon with a tiny left arrow; appears after a
 * short hover delay so it never flickers while moving between entries. */
const TOOLTIP_STYLE: CSSProperties = {
  position: "absolute",
  left: "calc(100% + 8px)",
  top: "50%",
  transform: "translateY(-50%)",
  zIndex: 400,
  pointerEvents: "none",
  whiteSpace: "nowrap",
  background: "#242824",
  color: "#ffffff",
  fontSize: 12,
  fontWeight: 450,
  padding: "6px 9px",
  borderRadius: 7,
  boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
};

const TOOLTIP_ARROW_STYLE: CSSProperties = {
  position: "absolute",
  left: -4,
  top: "50%",
  transform: "translateY(-50%) rotate(45deg)",
  width: 8,
  height: 8,
  background: "#242824",
  borderRadius: 1.5,
};

function IconSvg({ children, active }: { children: ReactNode; active: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ITEMS: ActivityItem[] = [
  {
    id: "sessions",
    titleKey: "activity.sessions",
    icon: (active) => (
      <IconSvg active={active}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </IconSvg>
    ),
  },
  {
    id: "skills",
    titleKey: "activity.skills",
    icon: (active) => (
      <IconSvg active={active}>
        <path d="M14.5 6.5v-3a1 1 0 0 0-1-1h-3a1 1 0 0 0-1 1v3" />
        <path d="M14.5 17.5v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3" />
        <path d="M6.5 9.5h-3a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h3" />
        <path d="M17.5 9.5h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3" />
        <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      </IconSvg>
    ),
  },
  {
    id: "terminal",
    titleKey: "activity.terminal",
    icon: (active) => (
      <IconSvg active={active}>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </IconSvg>
    ),
  },
];

interface Props {
  active: Activity;
  onSelect: (activity: Activity) => void;
  onSearch: () => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  hasRunningSession: boolean;
  hasUnreadSessions: boolean;
}

/** Icon-only rail entry: 20px icon, hover highlight + custom tooltip on the right. */
function RailButton({
  label,
  active = false,
  onClick,
  badge,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const [showTip, setShowTip] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  const enter = (e: MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = active ? "var(--accent-soft)" : "var(--bg-hover)";
    e.currentTarget.style.color = active ? "var(--accent-hover)" : "var(--text)";
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setShowTip(true), 120);
  };

  const leave = (e: MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = active ? "var(--accent-soft)" : "transparent";
    e.currentTarget.style.color = active ? "var(--accent-hover)" : "var(--text-muted)";
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setShowTip(false);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      onMouseEnter={enter}
      onMouseLeave={leave}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 40,
        height: 44,
        padding: 0,
        margin: "1px auto",
        background: active ? "var(--accent-soft)" : "transparent",
        border: "none",
        borderRadius: 10,
        color: active ? "var(--accent-hover)" : "var(--text-muted)",
        cursor: "pointer",
        transition: "background 0.12s, color 0.12s",
      }}
    >
      {/* active indicator bar — flush at the rail's left edge */}
      <span
        style={{
          position: "absolute",
          left: -14,
          top: "50%",
          transform: "translateY(-50%)",
          width: 3.5,
          height: 26,
          borderRadius: "0 4px 4px 0",
          background: active ? "var(--accent)" : "transparent",
          transition: "background 0.12s",
        }}
      />
      <span style={{ display: "inline-flex", position: "relative" }}>
        {children}
        {badge}
      </span>
      {showTip && (
        <span style={TOOLTIP_STYLE}>
          <span style={TOOLTIP_ARROW_STYLE} />
          {label}
        </span>
      )}
    </button>
  );
}

export function ActivityBar({ active, onSelect, onSearch, onToggleSidebar, sidebarOpen, hasRunningSession, hasUnreadSessions }: Props) {
  const { t } = useI18n();

  const sessionsBadge = (
    <>
      {hasRunningSession && (
        <span
          title={t("sidebar.agentRunning")}
          style={{
            position: "absolute",
            top: -2,
            right: -4,
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "var(--accent)",
            boxShadow: "0 0 0 2px var(--bg)",
          }}
        />
      )}
      {!hasRunningSession && hasUnreadSessions && (
        <span
          title={t("sidebar.newActivity")}
          style={{
            position: "absolute",
            top: -1,
            right: -3,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#0891b2",
            boxShadow: "0 0 0 2px var(--bg)",
          }}
        />
      )}
    </>
  );

  return (
    <div
      style={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        background: "var(--bg)",
        borderRight: "1px solid var(--hairline)",
        zIndex: 210,
      }}
    >
      {/* Brand logo — just the mark */}
      <button
        type="button"
        onClick={() => onSelect("sessions")}
        aria-label="Pi Studio"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 40,
          height: 40,
          margin: "10px auto 14px",
          padding: 0,
          background: "none",
          border: "none",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 4h7a5 5 0 0 1 5 5v11h-7a5 5 0 0 1-5-5V4z" fill="var(--accent)" stroke="none" />
          <path d="M13 4h7v7a5 5 0 0 1-5 5h-2" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      </button>

      <nav style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", flex: 1 }}>
        <RailButton
          label={t("activity.sessions")}
          active={active === "sessions"}
          onClick={() => onSelect("sessions")}
          badge={sessionsBadge}
        >
          {ITEMS[0].icon(active === "sessions")}
        </RailButton>
        <RailButton label={`${t("activity.search")} (Ctrl+K)`} onClick={onSearch}>
          <IconSvg active={false}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </IconSvg>
        </RailButton>
        {ITEMS.slice(1).map((item) => (
          <RailButton
            key={item.id}
            label={t(item.titleKey)}
            active={active === item.id}
            onClick={() => onSelect(item.id)}
          >
            {item.icon(active === item.id)}
          </RailButton>
        ))}
      </nav>

      {/* Bottom: settings + collapse */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", marginTop: 4 }}>
        <RailButton label={t("common.settings")} active={active === "settings"} onClick={() => onSelect("settings")}>
          <IconSvg active={active === "settings"}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </IconSvg>
        </RailButton>
        <RailButton label={sidebarOpen ? t("sidebar.hide") : t("sidebar.show")} onClick={onToggleSidebar}>
          <IconSvg active={false}>
            {sidebarOpen ? <polyline points="11 6 5 12 11 18" /> : <polyline points="13 6 19 12 13 18" />}
          </IconSvg>
        </RailButton>
      </div>
    </div>
  );
}
