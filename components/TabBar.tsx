"use client";

import { useState } from "react";
import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";

export interface Tab {
  id: string;
  label: string;
  /** "file" = local file or spreadsheet opened in the viewer, "web" = web page in the browser panel, "terminal" = terminal panel. */
  kind: "file" | "web" | "terminal";
  /** Absolute path — present for kind === "file". */
  filePath?: string;
  /** Target URL — present for kind === "web" (null = fresh empty browser tab). */
  url?: string | null;
  sourceSessionId?: string | null;
  initialDisplayMode?: "source" | "preview" | "diff";
  /** Which right-panel mode owns this tab. A tab lives in exactly ONE mode's
   *  bar — the .univer produced by AI-editing a document stays in 文件 while
   *  xlsx/csv live in 表格 — instead of duplicating in both (user report
   *  2026-08-27). Legacy tabs without the field fall back to the extension
   *  rule in AppShell.tabHomeMode. */
  homeMode?: "files" | "sheets";
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        /* 玻璃卡内部：不能用自己的不透明底色（会在卡里拉出一块白板），
           透出卡片本身的玻璃底；选中页签用 --bg 提亮以示区分。 */
        background: "transparent",
        boxShadow: "inset 0 -1px 0 var(--hairline)",
        overflowX: "auto",
        flexShrink: 0,
        height: 36,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            onMouseEnter={() => setHoveredTab(tab.id)}
            onMouseLeave={() => setHoveredTab((id) => (id === tab.id ? null : id))}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 36,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--hairline)",
              /* 悬停反馈与会话列表同一套：--bg-hover 提亮 + 文字提色 */
              background: isActive ? "var(--glass-bg)" : hoveredTab === tab.id ? "var(--bg-hover)" : "transparent",
              cursor: "pointer",
              fontSize: 12,
              color: isActive || hoveredTab === tab.id ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              transition: "background 0.1s, color 0.1s",
            }}
          >
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {tab.kind === "web" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              ) : tab.kind === "terminal" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              ) : (
                getFileIcon(tab.label, 13)
              )}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.kind === "web" ? (tab.url ?? tab.label) : (tab.filePath ?? tab.label)}
            >
              {tab.label}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24,
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: 4,
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: "background 0.1s, color 0.1s",
              }}
               title={t("i18n.close")}
               aria-label={`${t("i18n.close")} ${tab.label}`}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
