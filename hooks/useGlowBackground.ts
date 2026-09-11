"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * Glow background settings — enabled, visual style, and glow intensity.
 * All persisted to localStorage.
 *
 * Mirrors useAccentColor (globalThis-backed store so it survives Next.js hot
 * reload). The GlowBackground component reads these and fully tears down its
 * canvas/animation when disabled, so turning it off costs zero CPU.
 */

export type GlowStyle = "particles" | "planets" | "aurora" | "stars" | "bokeh" | "waves" | "nebula";

export const GLOW_STYLE_IDS: GlowStyle[] = ["particles", "planets", "aurora", "stars", "bokeh", "waves", "nebula"];
export const GLOW_INTENSITY_MIN = 0.4;
export const GLOW_INTENSITY_MAX = 1.6;
export const GLOW_INTENSITY_DEFAULT = 1.0;

const STORAGE_ENABLED = "pi-glow-background";
const STORAGE_STYLE = "pi-glow-style";
const STORAGE_INTENSITY = "pi-glow-intensity";

const DEFAULT_ENABLED = true;
const DEFAULT_STYLE: GlowStyle = "particles";

interface GlowStore {
  version: number;
  enabled: boolean;
  style: GlowStyle;
  intensity: number;
  listeners: Set<() => void>;
}

function getStore(): GlowStore {
  if (!globalThis.__piGlowStore) {
    globalThis.__piGlowStore = {
      version: 0,
      enabled: DEFAULT_ENABLED,
      style: DEFAULT_STYLE,
      intensity: GLOW_INTENSITY_DEFAULT,
      listeners: new Set(),
    };
  }
  return globalThis.__piGlowStore;
}

declare global {
  var __piGlowStore: GlowStore | undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isGlowStyle(v: string | null | undefined): v is GlowStyle {
  return !!v && (GLOW_STYLE_IDS as string[]).includes(v);
}

function readStored(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function readStoredEnabled(): boolean {
  const raw = readStored(STORAGE_ENABLED, String(DEFAULT_ENABLED));
  return raw !== "0" && raw !== "false";
}

function readStoredStyle(): GlowStyle {
  const raw = readStored(STORAGE_STYLE, DEFAULT_STYLE);
  return isGlowStyle(raw) ? raw : DEFAULT_STYLE;
}

function readStoredIntensity(): number {
  const raw = Number(readStored(STORAGE_INTENSITY, String(GLOW_INTENSITY_DEFAULT)));
  return Number.isFinite(raw) ? clamp(raw, GLOW_INTENSITY_MIN, GLOW_INTENSITY_MAX) : GLOW_INTENSITY_DEFAULT;
}

function subscribe(listener: () => void): () => void {
  const store = getStore();
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/** A version token that advances whenever any field changes, re-triggering renders. */
function getSnapshot(): number {
  return getStore().version;
}

function getServerSnapshot(): number {
  return 0;
}

export function useGlowBackground() {
  const version = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const store = getStore();
  const { enabled, style, intensity } = store;

  // Initialize from localStorage after hydration so persisted values win.
  useEffect(() => {
    const st = getStore();
    const nextEnabled = readStoredEnabled();
    const nextStyle = readStoredStyle();
    const nextIntensity = readStoredIntensity();
    if (
      nextEnabled !== st.enabled ||
      nextStyle !== st.style ||
      nextIntensity !== st.intensity
    ) {
      st.enabled = nextEnabled;
      st.style = nextStyle;
      st.intensity = nextIntensity;
      st.version++;
      st.listeners.forEach((cb) => cb());
    }
  }, []);

  const setGlowEnabled = useCallback((value: boolean) => {
    const st = getStore();
    st.enabled = value;
    st.version++;
    st.listeners.forEach((cb) => cb());
    try {
      window.localStorage.setItem(STORAGE_ENABLED, value ? "1" : "0");
    } catch {
      // ignore storage errors
    }
  }, []);

  const setGlowStyle = useCallback((value: GlowStyle) => {
    const st = getStore();
    st.style = value;
    st.version++;
    st.listeners.forEach((cb) => cb());
    try {
      window.localStorage.setItem(STORAGE_STYLE, value);
    } catch {
      // ignore
    }
  }, []);

  const setGlowIntensity = useCallback((value: number) => {
    const clamped = clamp(value, GLOW_INTENSITY_MIN, GLOW_INTENSITY_MAX);
    const st = getStore();
    st.intensity = clamped;
    st.version++;
    st.listeners.forEach((cb) => cb());
    try {
      window.localStorage.setItem(STORAGE_INTENSITY, String(clamped));
    } catch {
      // ignore
    }
  }, []);

  /** 只把光晕强度还原成默认值（不动开关与样式）——“重置外观”按钮用。 */
  const resetGlowIntensity = useCallback(() => {
    const st = getStore();
    st.intensity = GLOW_INTENSITY_DEFAULT;
    st.version++;
    st.listeners.forEach((cb) => cb());
    try {
      window.localStorage.removeItem(STORAGE_INTENSITY);
    } catch {
      // ignore
    }
  }, []);

  const resetGlowEnabled = useCallback(() => {
    const st = getStore();
    st.enabled = DEFAULT_ENABLED;
    st.style = DEFAULT_STYLE;
    st.intensity = GLOW_INTENSITY_DEFAULT;
    st.version++;
    st.listeners.forEach((cb) => cb());
    try {
      window.localStorage.removeItem(STORAGE_ENABLED);
      window.localStorage.removeItem(STORAGE_STYLE);
      window.localStorage.removeItem(STORAGE_INTENSITY);
    } catch {
      // ignore
    }
  }, []);

  const _ = version; // referenced so the hook re-renders when the store changes
  void _;

  return {
    enabled,
    style,
    intensity,
    setGlowEnabled,
    setGlowStyle,
    setGlowIntensity,
    resetGlowIntensity,
    resetGlowEnabled,
  };
}
