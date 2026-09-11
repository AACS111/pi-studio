/**
 * DraggableResizableModal —— 通用「可拖动 + 可缩放」弹窗。
 *  - 顶栏整条可拖动移动位置；四周 8 个方位把手（n/s/e/w/ne/nw/se/sw）可拉大/缩小。
 *  - 用 pointer 事件实现（兼容鼠标/触屏），通过 createPortal 挂 <body>，z-index 全局最高，
 *    暗色蒙版覆盖一切（含最左侧一级导航）。
 *  - 项目组设置、团队模板等所有弹窗统一用它，保证一致的拖动/缩放体验。
 *
 * 用法：
 *   <DraggableResizableModal title="..." onClose={...} width={640} height={480} hint="拖动顶栏移动·拉边缩放">
 *     {内容}
 *   </DraggableResizableModal>
 */
"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNativeOverlayGuard } from "@/hooks/useNativeOverlayGuard";

type Dir = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: { dir: Dir; cursor: string; label: string }[] = [
  { dir: "n", cursor: "ns-resize", label: "上边（上下拉高）" },
  { dir: "s", cursor: "ns-resize", label: "下边（上下拉高）" },
  { dir: "e", cursor: "ew-resize", label: "右边（左右拉宽）" },
  { dir: "w", cursor: "ew-resize", label: "左边（左右拉宽）" },
  { dir: "ne", cursor: "nesw-resize", label: "右上角" },
  { dir: "nw", cursor: "nwse-resize", label: "左上角" },
  { dir: "se", cursor: "nwse-resize", label: "右下角" },
  { dir: "sw", cursor: "nesw-resize", label: "左下角" },
];

const MIN_W = 320;
const MIN_H = 220;

export function DraggableResizableModal({
  title = "",
  hint = "↕ 拖动顶栏移动位置 · 拖边缘/四角调整大小",
  onClose,
  children,
  width = 640,
  height = 460,
  zIndex = 9999,
}: {
  title?: string;
  hint?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number | string;
  height?: number | string;
  zIndex?: number;
}) {
  // 原生右侧浏览器（WebContentsView）永远盖在 HTML 之上，弹窗打开期间需隐藏它。
  useNativeOverlayGuard();
  // 位置与尺寸（px 数值；初始即按视口居中，避免首帧小尺寸/闪烁）
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number }>(() => {
    // SSR 安全：给一个合理默认值（客户端 mount 后 useEffect 会立即用真实视口居中校准）
    const vw = typeof window !== "undefined" ? window.innerWidth : 1440;
    const vh = typeof window !== "undefined" ? window.innerHeight : 900;
    const numW = typeof width === "number" ? width : (typeof width === "string" ? (parseFloat(width) / 100) * vw : 760);
    const numH = typeof height === "number" ? height : (typeof height === "string" ? (parseFloat(height) / 100) * vh : 460);
    const w = Math.max(MIN_W, Math.min(numW, vw * 0.96));
    const h = Math.max(MIN_H, Math.min(numH, vh * 0.92));
    return { x: Math.max(0, Math.round((vw - w) / 2)), y: Math.max(0, Math.round((vh - h) / 2)), w: Math.round(w), h: Math.round(h) };
  });
  const drag = useRef<{ dir: Dir; startX: number; startY: number; rect: { x: number; y: number; w: number; h: number } } | null>(null);
  // 刚发生过拖动：下一次点击背板不关闭（避免拖出浮层后 click 落在遮罩上直接把弹窗关掉）
  const justDraggedRef = useRef(false);

  // 客户端首次挂载时，用真实视口居中校准（覆盖 SSR 默认值或 hydration 不匹配）
  const calibratedRef = useRef(false);
  useEffect(() => {
    if (calibratedRef.current) return;
    calibratedRef.current = true;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const numW = typeof width === "number" ? width : (typeof width === "string" ? (parseFloat(width) / 100) * vw : 760);
    const numH = typeof height === "number" ? height : (typeof height === "string" ? (parseFloat(height) / 100) * vh : 460);
    const w = Math.max(MIN_W, Math.min(numW, vw * 0.96));
    const h = Math.max(MIN_H, Math.min(numH, vh * 0.92));
    setRect({ x: Math.max(0, Math.round((vw - w) / 2)), y: Math.max(0, Math.round((vh - h) / 2)), w: Math.round(w), h: Math.round(h) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback((dir: Dir, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 只有 left button 参与拖动/缩放
    e.preventDefault();
    const t = e.currentTarget as HTMLElement;
    t.setPointerCapture(e.pointerId);
    drag.current = { dir, startX: e.clientX, startY: e.clientY, rect };

    const onMove = (ev: PointerEvent) => {
      const d = drag.current!;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) justDraggedRef.current = true;
      const cur = d.rect;

      if (d.dir === "move") {
        setRect({ ...cur, x: cur.x + dx, y: cur.y + dy });
        return;
      }
      // —— resize：按方位调整左右/上下两侧 ——
      let x = cur.x, y = cur.y, w = cur.w, h = cur.h;
      if (d.dir === "e" || d.dir === "se" || d.dir === "ne") w = cur.w + dx; // 右缘
      if (d.dir === "w" || d.dir === "sw" || d.dir === "nw") { w = cur.w - dx; x = cur.x + dx; } // 左缘
      if (d.dir === "s" || d.dir === "se" || d.dir === "sw") h = cur.h + dy; // 下缘
      if (d.dir === "n" || d.dir === "ne" || d.dir === "nw") { h = cur.h - dy; y = cur.y + dy; } // 上缘
      // 卡最小值（避免缩没）
      if (w < MIN_W) {
        if (d.dir === "w" || d.dir === "sw" || d.dir === "nw") x = cur.x + cur.w - MIN_W;
        w = MIN_W;
      }
      if (h < MIN_H) {
        if (d.dir === "n" || d.dir === "ne" || d.dir === "nw") y = cur.y + cur.h - MIN_H;
        h = MIN_H;
      }
      setRect({ x, y, w, h });
    };
    const onUp = () => {
      t.releasePointerCapture(e.pointerId);
      t.removeEventListener("pointermove", onMove);
      t.removeEventListener("pointerup", onUp);
      t.removeEventListener("pointercancel", onUp);
      if (drag.current && !justDraggedRef.current) {
        // 没真正拖动（无位移）→ 视为点击：若落在背板由背板 onClick 关闭；浮层内 stopPropagation
      }
      drag.current = null;
    };
    t.addEventListener("pointermove", onMove);
    t.addEventListener("pointerup", onUp);
    t.addEventListener("pointercancel", onUp);
  }, [rect]);

  const overlay = (
    <div
      style={{
        position: "fixed", inset: 0, zIndex,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
      }}
      onClick={() => {
        if (justDraggedRef.current) {
          // 刚拖动过：本次点击是拖动的收尾，忽略，避免误关
          justDraggedRef.current = false;
          return;
        }
        onClose();
      }}
    >
      {/* 浮层 */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          left: rect.x, top: rect.y,
          width: rect.w,
          height: rect.h,
          maxWidth: "96vw", maxHeight: "92vh",
          background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)",
          display: "flex", flexDirection: "column", padding: 12, boxSizing: "border-box",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
        }}
      >
        {/* 顶栏：整条可拖动（关闭按钮区除外） */}
        <div
          onPointerDown={(e) => start("move", e)}
          style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexShrink: 0, cursor: "move", userSelect: "none", touchAction: "none", minHeight: 30, boxSizing: "border-box" }}
          title={hint || "拖动顶栏移动位置"}
        >
          {title && <span style={{ fontSize: 14, fontWeight: 700 }}>{title}</span>}
          {hint && !title && (
            <span style={{ fontSize: 10.5, color: "var(--text-dim)", marginLeft: 2, whiteSpace: "nowrap" }}>
              {hint}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
            style={{
              background: "transparent", color: "var(--text-muted)", border: "none", borderRadius: "var(--radius-sm)",
              width: 30, height: 30, fontSize: 16, cursor: "pointer", flexShrink: 0, lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>
        {/* 内容区 */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{children}</div>
      </div>

      {/* 缩放把手（8 个方位：4 边 + 4 角；骑跨浮层边缘，细长条，半透明淡色便于发现） */}
      {rect &&
        HANDLES.map((hd) => {
          const corner = hd.dir === "nw" || hd.dir === "ne" || hd.dir === "sw" || hd.dir === "se";
          const wide = hd.dir === "e" || hd.dir === "w"; // 左右边把手拉长
          const size = corner ? 14 : 8;
          const longSide = corner ? size : 44;
          const thickness = corner ? size : size;
          // 把手中心落在边界线上（一半在框外一半在框内）
          const hx = hd.dir.includes("w")
            ? -size / 2
            : hd.dir.includes("e")
              ? rect.w - size / 2
              : (rect.w - longSide) / 2;
          const hy = hd.dir.includes("n")
            ? -size / 2
            : hd.dir.includes("s")
              ? rect.h - size / 2
              : (rect.h - longSide) / 2;
          return (
            <div
              key={hd.dir}
              title={hd.label}
              onPointerDown={(e) => {
                e.stopPropagation(); // 不冒泡到背板（否则点击把手会被当成“点遮罩关闭”)
                start(hd.dir, e);
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "fixed",
                left: rect.x + hx,
                top: rect.y + hy,
                width: wide ? longSide : thickness,
                height: wide ? thickness : longSide,
                cursor: hd.cursor,
                touchAction: "none",
                zIndex,
              }}
            />
          );
        })}
    </div>
  );

  return typeof window !== "undefined" ? createPortal(overlay, document.body) : null;
}