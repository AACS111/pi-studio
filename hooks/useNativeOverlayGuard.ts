"use client";

import { useEffect } from "react";

/**
 * 原生图层遮挡守卫（仅 Electron 桌面模式有效）。
 *
 * 右侧浏览器由 Electron 主进程的 WebContentsView 提供——它是**独立于 DOM 的原生图层**，
 * 永远盖在所有 HTML 之上，且不受任何 CSS z-index 约束。所以设置 / 模型配置 / 目录选择等
 * DOM 弹窗打开时，浏览器内容会反过来压住弹窗（弹窗被浏览器挡掉一半，遮罩也盖不住）。
 *
 * 这里用一个全局计数器登记「当前有多少个全屏弹窗/遮罩处于打开状态」，0 → >0 时通知
 * 主进程把原生视图临时隐藏，弹窗关闭回到 0 时自动恢复显示（主进程按上次 bounds 重画）。
 * 计数而非布尔，保证弹窗叠加（如「模型配置」上再开「添加提供商」）时不会提前恢复。
 *
 * 用法：在任何全屏弹窗组件顶层调用 `useNativeOverlayGuard()`（或传 active 控制）。
 */
let openOverlayCount = 0;
let lastSuspended = false;

function syncNativeOverlayState() {
  const suspended = openOverlayCount > 0;
  if (suspended === lastSuspended) return;
  lastSuspended = suspended;
  try {
    window.piElectron?.webview?.setOverlay?.(suspended);
  } catch {
    /* 纯浏览器模式 / 桥不可用：静默忽略 */
  }
}

export function useNativeOverlayGuard(active = true): void {
  useEffect(() => {
    if (!active) return;
    openOverlayCount += 1;
    syncNativeOverlayState();
    return () => {
      openOverlayCount = Math.max(0, openOverlayCount - 1);
      syncNativeOverlayState();
    };
  }, [active]);
}
