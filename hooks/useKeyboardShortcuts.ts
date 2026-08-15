"use client";

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Module-level registry — ChatWindow registers the abort handler here so that
// the global Esc listener in AppShell can call it without prop-drilling.
// ---------------------------------------------------------------------------
let globalAbortHandler: (() => void) | null = null;

/**
 * Register (or clear) the abort handler for the global Esc shortcut.
 * Call this from ChatWindow whenever agentRunning or handleAbort changes.
 */
export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

// ---------------------------------------------------------------------------
// Hook: global keyboard shortcuts
// ---------------------------------------------------------------------------

interface UseGlobalKeyboardShortcutsOptions {
  /** Called when Ctrl+Alt+N is pressed. Receives current cwd. */
  onNewSession?: (cwd: string) => void;
  /** The currently selected project directory (sidebar cwd). */
  activeCwd?: string | null;
  /** Called when Ctrl/Cmd+F (or with Shift) is pressed — open content search. */
  onSearchContent?: () => void;
  /** Called when Ctrl/Cmd+K is pressed — open the global command palette. */
  onCommandPalette?: () => void;
  /** Called when Ctrl/Cmd+P is pressed — open the quick file open palette. */
  onQuickOpen?: () => void;
}

/**
 * Register global keyboard shortcuts for the application.
 *
 * Shortcuts handled here:
 *   Esc          – stop the running agent (via module-level abort handler)
 *   Ctrl+Alt+N   – create a new session in the active project directory
 *   Ctrl/Cmd+F   – open the session content search (with Shift: same)
 *
 * Note: Esc inside <textarea> or <input> is deliberately NOT handled here.
 * ChatInput manages its own Esc logic (closing slash / @ file menus, stopping
 * the agent when no menu is open) because it needs intimate knowledge of menu
 * state that is local to that component.
 */
export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const { onNewSession, activeCwd, onSearchContent, onCommandPalette, onQuickOpen } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // ---- Esc: stop agent ----
      if (e.key === "Escape") {
        if (!globalAbortHandler) return;

        const tag = (e.target as HTMLElement)?.tagName;
        // Let textarea/input handle Esc internally (ChatInput menus / stop).
        if (tag === "TEXTAREA" || tag === "INPUT") return;

        e.preventDefault();
        globalAbortHandler();
        return;
      }

      // ---- Ctrl+Alt+N: new session ----
      if (e.key === "n" && e.ctrlKey && e.altKey) {
        if (!activeCwd || !onNewSession) return;
        e.preventDefault();
        onNewSession(activeCwd);
      }

      // ---- Ctrl/Cmd+F: search session content (Ctrl+Shift+F included) ----
      if (e.key.toLowerCase() === "f" && (e.ctrlKey || e.metaKey) && !e.altKey) {
        if (!onSearchContent) return;
        e.preventDefault();
        onSearchContent();
        return;
      }

      // ---- Ctrl/Cmd+K: global command palette ----
      if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        if (!onCommandPalette) return;
        e.preventDefault();
        onCommandPalette();
        return;
      }

      // ---- Ctrl/Cmd+P: quick open file ----
      if (e.key.toLowerCase() === "p" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        if (!onQuickOpen) return;
        e.preventDefault();
        onQuickOpen();
        return;
      }

      // ---- Ctrl/Cmd+N: new session ----
      if (e.key.toLowerCase() === "n" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        if (!activeCwd || !onNewSession) return;
        e.preventDefault();
        onNewSession(activeCwd);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeCwd, onNewSession, onSearchContent, onCommandPalette, onQuickOpen]);
}
