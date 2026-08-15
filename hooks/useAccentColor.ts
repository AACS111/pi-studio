"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useTheme } from "./useTheme";

/**
 * Accent (theme) color management — vben-admin style.
 *
 * A preset palette + a free-form color picker. The chosen accent drives a set
 * of derived CSS variables (`--accent`, `--accent-hover`, `--accent-soft`,
 * `--user-bg`) that are computed per light/dark mode and written onto
 * `document.documentElement`, overriding the defaults in globals.css.
 *
 * The value is persisted to localStorage. The store lives on globalThis so it
 * survives Next.js hot reload (same pattern as the session registry).
 */

export interface AccentPreset {
  name: string;
  /** Presets are stored in the SAME form as a picker value: #rrggbb. */
  value: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { name: "green", value: "#5BAF68" },
  { name: "blue", value: "#3B82F6" },
  { name: "violet", value: "#8B5CF6" },
  { name: "orange", value: "#F59E0B" },
  { name: "red", value: "#EF4444" },
  { name: "cyan", value: "#06B6D4" },
  { name: "pink", value: "#EC4899" },
];

const STORAGE_KEY = "pi-accent-color";

/* ── color helpers ─────────────────────────────────────────────────────── */

function clamp(value: number, min = 0, max = 255): number {
  return Math.min(max, Math.max(min, value));
}

/** Accepts #rgb / #rrggbb. Returns #rrggbb or null. */
export function normalizeHex(input: string): string | null {
  const raw = input.trim();
  const m = raw.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) {
    hex = hex.split("").map((c) => c + c).join("");
  }
  return `#${hex.toLowerCase()}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = normalizeHex(hex);
  const raw = normalized ? normalized.slice(1) : "5baf68";
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (n: number) => clamp(Math.round(n)).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100, ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgbToHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
}

/** Shift lightness by a signed delta (percent). */
function adjustLightness(hex: string, delta: number): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, clamp(l + delta, 0, 100));
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Mix hexA (weight 0..1) with hexB. weight=1 → pure hexA. */
function mix(hexA: string, hexB: string, weight: number): string {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const w = clamp(weight, 0, 1);
  return rgbToHex(
    a.r * w + b.r * (1 - w),
    a.g * w + b.g * (1 - w),
    a.b * w + b.b * (1 - w),
  );
}

/** Neutral base surfaces (pure neutrals — no leftover green tint from the
 *  original palette) that the accent gets mixed into. */
const NEUTRAL_BG = {
  light: { bg: "#F5F5F5", panel: "#ECECEC", border: "#B8B8B8" },
  dark: { bg: "#1C1C1E", panel: "#222224", border: "#3A3A3C" },
};

/** Per-mode accent tint weight for the surface variables (kept subtle). */
const SURFACE_TINTS = {
  light: { bg: 0.03, panel: 0.03, hover: 0.06, selected: 0.07, border: 0.05 },
  dark: { bg: 0.025, panel: 0.025, hover: 0.05, selected: 0.06, border: 0.05 },
};

/* ── store (globalThis-backed so it survives hot reload) ───────────────── */

interface AccentStore {
  current: string;
  listeners: Set<() => void>;
}

function getStore(): AccentStore {
  if (!globalThis.__piAccentStore) {
    globalThis.__piAccentStore = { current: ACCENT_PRESETS[0].value, listeners: new Set() };
  }
  return globalThis.__piAccentStore;
}

declare global {
  var __piAccentStore: AccentStore | undefined;
}

function readStoredAccent(): string {
  if (typeof window === "undefined") return getStore().current;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const normalized = stored ? normalizeHex(stored) : null;
    if (normalized) return normalized;
  } catch {
    // ignore storage errors
  }
  return getStore().current;
}

function subscribe(listener: () => void): () => void {
  const store = getStore();
  store.listeners.add(listener);
  return () => { store.listeners.delete(listener); };
}

function getSnapshot(): string {
  return getStore().current;
}

function getServerSnapshot(): string {
  return ACCENT_PRESETS[0].value;
}

/* ── hook ──────────────────────────────────────────────────────────────── */

export function useAccentColor(options?: { apply?: boolean }) {
  const { isDark } = useTheme();
  const shouldApply = options?.apply !== false;
  const accent = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Initialize from localStorage on first client render (after hydration).
  useEffect(() => {
    const stored = readStoredAccent();
    if (stored !== getStore().current) {
      getStore().current = stored;
      getStore().listeners.forEach((cb) => cb());
    }
  }, []);

  // Apply derived CSS variables whenever the accent or mode changes.
  // Only the caller that owns the page (AppShell) should apply; the settings
  // panel only reads/sets the store so its unmount never clears the vars.
  useEffect(() => {
    if (!shouldApply) return;
    const root = document.documentElement;
    const neutral = isDark ? NEUTRAL_BG.dark : NEUTRAL_BG.light;
    const tint = isDark ? SURFACE_TINTS.dark : SURFACE_TINTS.light;
    const derived: Record<string, string> = {
      "--accent": accent,
      // light: hover darkens; dark: hover lightens
      "--accent-hover": adjustLightness(accent, isDark ? 0.10 : -0.12),
      "--accent-soft": rgba(accent, isDark ? 0.12 : 0.10),
      "--user-bg": rgba(accent, isDark ? 0.10 : 0.06),
      // Surfaces follow the accent with a very subtle tint (lighter than the
      // old hard-coded green) so the whole theme shifts with the accent.
      "--bg": mix(accent, neutral.bg, tint.bg),
      "--bg-panel": mix(accent, neutral.panel, tint.panel),
      "--bg-hover": mix(accent, neutral.bg, tint.hover),
      "--bg-selected": mix(accent, neutral.bg, tint.selected),
      "--border": mix(accent, neutral.border, tint.border),
    };
    for (const [key, value] of Object.entries(derived)) {
      root.style.setProperty(key, value);
    }
    return () => {
      // Restore globals.css defaults when this hook unmounts.
      for (const key of Object.keys(derived)) root.style.removeProperty(key);
    };
  }, [accent, isDark, shouldApply]);

  const setAccentColor = useCallback((color: string) => {
    const normalized = normalizeHex(color);
    if (!normalized) return;
    const store = getStore();
    store.current = normalized;
    store.listeners.forEach((cb) => cb());
    try {
      window.localStorage.setItem(STORAGE_KEY, normalized);
    } catch {
      // ignore
    }
  }, []);

  /** Back to the built-in default accent. */
  const resetAccentColor = useCallback(() => {
    setAccentColor(ACCENT_PRESETS[0].value);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, [setAccentColor]);

  return { accent, setAccentColor, resetAccentColor, presets: ACCENT_PRESETS };
}
