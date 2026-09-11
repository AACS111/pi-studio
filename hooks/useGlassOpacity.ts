"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * Desktop glass opacity — 桌面玻璃的两档透明度（前景卡片 / 背景底板）。
 *
 * 两条滑块直接改 CSS 变量（写入 :root 的行内 style，优先级高于 globals.css）：
 *   foreground → --glass-bg 的不透明度（玻璃卡片本身）
 *   background → --glass-plate 遮罩的不透明度（壁纸/星空上那层统一底板）
 * 用 CSS 变量而不是复制一份主题，是为了两个运行形态（Electron 透明窗口 /
 * 浏览器）都能立刻看到效果，且不必重渲染 React 树。
 *
 * 持久化沿用 useGlowBackground 的模式：localStorage + globalThis store，
 * 这样设置面板与任何其他组件读到的值一致，热重载也不会丢。
 */

export const GLASS_OPACITY_MIN = 0;
export const GLASS_OPACITY_MAX = 100;
export const GLASS_OPACITY_STEP = 1;
/** 默认值需与 globals.css 中的定义保持一致（前景 52% 面板色 / 底板 28% 灰纱）。 */
export const GLASS_FOREGROUND_DEFAULT = 52;
export const GLASS_BACKGROUND_DEFAULT = 28;

const STORAGE_FOREGROUND = "pi-glass-foreground";
const STORAGE_BACKGROUND = "pi-glass-background";

interface GlassStore {
  version: number;
  foreground: number;
  background: number;
  listeners: Set<() => void>;
}

declare global {
  var __piGlassStore: GlassStore | undefined;
}

function getStore(): GlassStore {
  if (!globalThis.__piGlassStore) {
    globalThis.__piGlassStore = {
      version: 0,
      foreground: GLASS_FOREGROUND_DEFAULT,
      background: GLASS_BACKGROUND_DEFAULT,
      listeners: new Set(),
    };
  }
  return globalThis.__piGlassStore;
}

function subscribe(cb: () => void): () => void {
  const st = getStore();
  st.listeners.add(cb);
  return () => {
    st.listeners.delete(cb);
  };
}

function getSnapshot(): number {
  return getStore().version;
}

function getServerSnapshot(): number {
  return 0;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return GLASS_FOREGROUND_DEFAULT;
  return Math.min(GLASS_OPACITY_MAX, Math.max(GLASS_OPACITY_MIN, Math.round(value)));
}

function readStored(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? clampPct(n) : fallback;
  } catch {
    return fallback;
  }
}

/** 把两档透明度写成 CSS 变量；0% 的底板等价于「完全不加底板」。 */
export function applyGlassOpacity(foreground: number, background: number): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement.style;
  root.setProperty("--glass-foreground-opacity", String(foreground / 100));
  root.setProperty("--glass-background-opacity", String(background / 100));
}

export function useGlassOpacity() {
  const version = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const store = getStore();
  const { foreground, background } = store;

  // 水合后再读 localStorage（首屏 SSR 只能用默认值）并应用到 CSS 变量。
  useEffect(() => {
    const st = getStore();
    const nextForeground = readStored(STORAGE_FOREGROUND, GLASS_FOREGROUND_DEFAULT);
    const nextBackground = readStored(STORAGE_BACKGROUND, GLASS_BACKGROUND_DEFAULT);
    if (nextForeground !== st.foreground || nextBackground !== st.background) {
      st.foreground = nextForeground;
      st.background = nextBackground;
      st.version++;
      st.listeners.forEach((cb) => cb());
    }
    applyGlassOpacity(st.foreground, st.background);
  }, []);

  const setForeground = useCallback((value: number) => {
    const st = getStore();
    st.foreground = clampPct(value);
    st.version++;
    st.listeners.forEach((cb) => cb());
    applyGlassOpacity(st.foreground, st.background);
    try {
      window.localStorage.setItem(STORAGE_FOREGROUND, String(st.foreground));
    } catch {
      // ignore storage errors
    }
  }, []);

  const setBackground = useCallback((value: number) => {
    const st = getStore();
    st.background = clampPct(value);
    st.version++;
    st.listeners.forEach((cb) => cb());
    applyGlassOpacity(st.foreground, st.background);
    try {
      window.localStorage.setItem(STORAGE_BACKGROUND, String(st.background));
    } catch {
      // ignore
    }
  }, []);

  const resetGlassOpacity = useCallback(() => {
    const st = getStore();
    st.foreground = GLASS_FOREGROUND_DEFAULT;
    st.background = GLASS_BACKGROUND_DEFAULT;
    st.version++;
    st.listeners.forEach((cb) => cb());
    applyGlassOpacity(st.foreground, st.background);
    try {
      window.localStorage.removeItem(STORAGE_FOREGROUND);
      window.localStorage.removeItem(STORAGE_BACKGROUND);
    } catch {
      // ignore
    }
  }, []);

  void version; // 订阅版本号，store 变化时重渲染

  return {
    foreground,
    background,
    setForeground,
    setBackground,
    resetGlassOpacity,
  };
}
