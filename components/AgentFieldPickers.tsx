/**
 * AgentFieldPickers —— 角色表单的「点击输入框弹出选择」控件。
 *  - EmojiPicker：点击显示图标选择网格。
 *  - ToolPicker：点击弹出工具多选面板（checkbox），选中项以 chips 显示。
 * 两种控件均支持外部点击关闭，与既有下拉样式一致。
 */
"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AGENT_EMOJIS, AGENT_TOOLS } from "@/lib/team/ui-constants";

const inputStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "7px 10px",
  fontSize: 13,
  fontFamily: "inherit",
  background: "var(--bg)",
  color: "var(--text)",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const panelStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  zIndex: 40,
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
  padding: 6,
};

function useOutsideClose(open: boolean, ref: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open, ref, onClose]);
}

/** 图标选择：点击输入框 → 弹出 emoji 网格点选 */
export function EmojiPicker({ value, onChange, style, placeholder }: { value?: string; onChange: (v: string) => void; style?: CSSProperties; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useOutsideClose(open, ref, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ ...inputStyle, ...style, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", textAlign: "left" }}
      >
        <span style={{ fontSize: 15 }}>{value || "🤖"}</span>
        <span style={{ color: "var(--text-dim)", fontSize: 12, flex: 1 }}>{value ? placeholder ?? "" : placeholder ?? "选择图标"} ▾</span>
      </button>
      {open && (
        <div style={{ ...panelStyle, display: "grid", gridTemplateColumns: "repeat(8, 28px)", gap: 2, width: "max-content" }}>
          {AGENT_EMOJIS.map((em) => (
            <button
              key={em}
              type="button"
              onClick={() => { onChange(em); setOpen(false); }}
              style={{
                width: 28, height: 28, fontSize: 16, cursor: "pointer", borderRadius: 6,
                border: value === em ? "1.5px solid var(--accent)" : "1px solid transparent",
                background: value === em ? "var(--accent-soft, rgba(0,120,255,0.12))" : "transparent",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}
            >
              {em}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 工具多选：点击输入框 → 弹出 checkbox 面板，选中项 chips 展示 */
export function ToolPicker({ value, onChange, style, placeholder }: { value: string[]; onChange: (v: string[]) => void; style?: CSSProperties; placeholder?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useOutsideClose(open, ref, () => setOpen(false));
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ ...inputStyle, ...style, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", minHeight: 34 }}
      >
        {value.length === 0 && <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{placeholder ?? "选择工具"} ▾</span>}
        {value.map((t) => (
          <span key={t} style={{ fontSize: 11, background: "var(--accent-soft, rgba(0,120,255,0.10))", color: "var(--accent)", borderRadius: 6, padding: "1px 7px" }}>
            {t}
          </span>
        ))}
        {value.length > 0 && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>▾</span>}
      </button>
      {open && (
        <div style={{ ...panelStyle, display: "flex", flexDirection: "column", gap: 1, minWidth: 180 }}>
          {AGENT_TOOLS.map((tool) => {
            const checked = value.includes(tool);
            return (
              <label
                key={tool}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 6,
                  cursor: "pointer", fontSize: 12.5, color: "var(--text)",
                  background: checked ? "var(--accent-soft, rgba(0,120,255,0.08))" : "transparent",
                }}
              >
                <input type="checkbox" checked={checked} onChange={() => onChange(checked ? value.filter((x) => x !== tool) : [...value, tool])} style={{ margin: 0 }} />
                <span style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>{tool}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
