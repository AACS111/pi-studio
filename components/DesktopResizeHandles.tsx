"use client";

import { useEffect, useState } from "react";
import { getElectronApi, type PiElectronApi } from "@/lib/electron-api";

/**
 * DesktopResizeHandles — 自绘的窗口缩放把手（仅 Electron）。
 *
 * 背景：窗口开了 `transparent: true` 后，Windows 会丢掉原生 thick frame
 * （实测窗口 style 无 WS_THICKFRAME），原生边缘缩放失效，因此由页面在最外沿
 * 铺 8 个把手（4 边 + 4 角，各 6px），pointerdown 时把方位发给主进程，主进程用
 * `screen.getCursorScreenPoint()` 逐帧算新 bounds（见 main.cjs
 * pi-window-resize-*）。
 *
 * 把手是 fixed 定位、z-index 极高；玻璃卡片之间留了外边距，因此正常点击区域
 * 不会碰到它们。窗口最大化时整层隐藏（`isMaximized`）。
 */

type Dir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: { dir: Dir; style: React.CSSProperties }[] = [
  { dir: "n", style: { top: 0, left: 8, right: 8, height: 6, cursor: "ns-resize" } },
  { dir: "s", style: { bottom: 0, left: 8, right: 8, height: 6, cursor: "ns-resize" } },
  { dir: "w", style: { left: 0, top: 8, bottom: 8, width: 6, cursor: "ew-resize" } },
  { dir: "e", style: { right: 0, top: 8, bottom: 8, width: 6, cursor: "ew-resize" } },
  { dir: "nw", style: { top: 0, left: 0, width: 10, height: 10, cursor: "nwse-resize" } },
  { dir: "se", style: { bottom: 0, right: 0, width: 10, height: 10, cursor: "nwse-resize" } },
  { dir: "ne", style: { top: 0, right: 0, width: 10, height: 10, cursor: "nesw-resize" } },
  { dir: "sw", style: { bottom: 0, left: 0, width: 10, height: 10, cursor: "nesw-resize" } },
];

export function DesktopResizeHandles() {
  const [api, setApi] = useState<PiElectronApi | undefined>(undefined);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const a = getElectronApi();
    if (!a?.window?.beginResize) return;
    setApi(a);
    let alive = true;
    void a.window.isMaximized?.().then((m) => {
      if (alive) setMaximized(m);
    });
    const off = a.window.onMaximizedChange?.((m) => setMaximized(m));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  if (!api?.window?.beginResize || maximized) return null;
  const win = api.window;

  const begin = (dir: Dir, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    win.beginResize?.(dir);
    // 拖动期间 pointermove 会跑到别的元素上，直接听 window；
    // 在主进程算 bounds 之前先把光标样式定住，避免指针一离开把手就变回箭头。
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor =
      dir === "n" || dir === "s" ? "ns-resize" : dir === "e" || dir === "w" ? "ew-resize" : dir === "nw" || dir === "se" ? "nwse-resize" : "nesw-resize";
    document.body.style.userSelect = "none";

    let raf = 0;
    const onMove = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        win.moveResize?.();
      });
    };
    const finish = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      win.endResize?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  return (
    <div
      aria-hidden="true"
      data-testid="desktop-resize-handles"
      style={{ position: "fixed", inset: 0, zIndex: 99999, pointerEvents: "none" }}
    >
      {HANDLES.map(({ dir, style }) => (
        <div
          key={dir}
          data-resize-dir={dir}
          onPointerDown={(e) => begin(dir, e)}
          style={{ position: "absolute", pointerEvents: "auto", ...style }}
        />
      ))}
    </div>
  );
}
