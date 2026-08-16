"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";

interface Props {
  cwd: string | null;
}

interface TabState {
  id: string;
  shellId: string;
  shellLabel: string;
  status: "running" | "exited";
  index: number;
}

interface TerminalInstance {
  term: Terminal;
  fit: FitAddon;
  pendingInput: string;
  flushTimer: number | null;
  abortSse: () => void;
}

const STORAGE_KEY = "pi-terminal-tabs";
const INPUT_FLUSH_MS = 20;
const CONTROL_CHARS_RE = /[\x03\x04\r\n\x1b\x7f]/;

function buildTheme(isDark: boolean) {
  return isDark
    ? {
        background: "#1B1D20",
        foreground: "#e6e6e6",
        cursor: "#e6e6e6",
        cursorAccent: "#1B1D20",
        selectionBackground: "rgba(99, 141, 116, 0.4)",
        black: "#1f2937",
        red: "#dc2626",
        green: "#16a34a",
        yellow: "#d97706",
        blue: "#0a84ff",
        magenta: "#9333ea",
        cyan: "#0891b2",
        white: "#e5e7eb",
        brightBlack: "#6b7280",
        brightRed: "#ef4444",
        brightGreen: "#22c55e",
        brightYellow: "#f59e0b",
        brightBlue: "#0a84ff",
        brightMagenta: "#a855f7",
        brightCyan: "#06b6d4",
        brightWhite: "#f9fafb",
      }
    : {
        background: "#F6F6F3",
        foreground: "#1f2937",
        cursor: "#1f2937",
        cursorAccent: "#F6F6F3",
        selectionBackground: "rgba(99, 141, 116, 0.25)",
        black: "#1f2937",
        red: "#dc2626",
        green: "#16a34a",
        yellow: "#d97706",
        blue: "#0a84ff",
        magenta: "#9333ea",
        cyan: "#0891b2",
        white: "#374151",
        brightBlack: "#6b7280",
        brightRed: "#ef4444",
        brightGreen: "#22c55e",
        brightYellow: "#f59e0b",
        brightBlue: "#0a84ff",
        brightMagenta: "#a855f7",
        brightCyan: "#06b6d4",
        brightWhite: "#111827",
      };
}

function postInput(id: string, body: Record<string, unknown>): void {
  void fetch(`/api/terminal/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function flushInput(id: string, inst: TerminalInstance): void {
  if (inst.flushTimer !== null) {
    window.clearTimeout(inst.flushTimer);
    inst.flushTimer = null;
  }
  const data = inst.pendingInput;
  if (!data) return;
  inst.pendingInput = "";
  postInput(id, { data });
}

function connectSse(
  id: string,
  inst: TerminalInstance,
  onStatus: (status: "running" | "exited") => void,
): () => void {
  const controller = new AbortController();
  let closed = false;
  let resetBeforeReplay = true;

  const run = async () => {
    while (!closed) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const res = await fetch(`/api/terminal/${encodeURIComponent(id)}/events`, { signal: controller.signal });
        if (!res.ok || !res.body) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        // Reset before the server's buffer replay so a reload/reconnect never
        // duplicates output already shown in the view.
        if (resetBeforeReplay) {
          inst.term.reset();
          resetBeforeReplay = false;
        }
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, boundary);
            buf = buf.slice(boundary + 2);
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const event = JSON.parse(line.slice(6)) as { type: string; data?: string; status?: "running" | "exited" };
                if (event.type === "data" && event.data) inst.term.write(event.data);
                else if (event.type === "status" && event.status) onStatus(event.status);
              } catch {
                // Ignore malformed frames.
              }
            }
          }
        }
        // Stream ended unexpectedly → reconnect with a fresh replay.
        resetBeforeReplay = true;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } catch {
        break; // aborted on dispose
      } finally {
        try {
          reader?.cancel().catch(() => {});
        } catch {
          // ignore
        }
      }
    }
  };
  void run();

  return () => {
    closed = true;
    controller.abort();
  };
}

/** One xterm view per tab. All views stay mounted; only the active one is visible. */
function TerminalTabView({
  tab,
  active,
  isDark,
  onStatusChange,
  onInstance,
}: {
  tab: TabState;
  active: boolean;
  isDark: boolean;
  onStatusChange: (id: string, status: "running" | "exited") => void;
  onInstance: (id: string, inst: TerminalInstance | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<TerminalInstance | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: "var(--font-mono), Consolas, 'Courier New', monospace",
      theme: buildTheme(isDark),
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    const inst: TerminalInstance = {
      term,
      fit,
      pendingInput: "",
      flushTimer: null,
      abortSse: () => {},
    };
    instanceRef.current = inst;

    term.onData((data) => {
      inst.pendingInput += data;
      if (inst.flushTimer === null) {
        inst.flushTimer = window.setTimeout(() => flushInput(tab.id, inst), INPUT_FLUSH_MS);
      }
      if (CONTROL_CHARS_RE.test(data)) flushInput(tab.id, inst);
    });

    term.onResize(({ cols, rows }) => {
      if (cols > 0 && rows > 0) postInput(tab.id, { resize: { cols, rows } });
    });

    inst.abortSse = connectSse(tab.id, inst, (status) => onStatusChange(tab.id, status));
    onInstance(tab.id, inst);

    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        // container not measurable yet
      }
    });

    return () => {
      if (inst.flushTimer !== null) window.clearTimeout(inst.flushTimer);
      inst.abortSse();
      onInstance(tab.id, null);
      instanceRef.current = null;
      term.dispose();
    };
    // Mount once per tab id — theme updates are applied via the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // Live theme update.
  useEffect(() => {
    const inst = instanceRef.current;
    if (inst) inst.term.options.theme = buildTheme(isDark);
  }, [isDark]);

  // Fit when this tab becomes active.
  useEffect(() => {
    if (!active) return;
    const inst = instanceRef.current;
    if (!inst) return;
    requestAnimationFrame(() => {
      try {
        inst.fit.fit();
        inst.term.refresh(0, inst.term.rows - 1);
      } catch {
        // ignore
      }
    });
  }, [active]);

  // Refit on container resize (only the active tab).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (!activeRef.current) return;
      const inst = instanceRef.current;
      if (!inst) return;
      try {
        inst.fit.fit();
      } catch {
        // ignore
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        display: active ? "block" : "none",
        padding: "6px 8px",
        boxSizing: "border-box",
      }}
    />
  );
}

export function TerminalPanel({ cwd }: Props) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const nextIndexRef = useRef(1);
  const instancesRef = useRef(new Map<string, TerminalInstance>());
  const tabsRef = useRef<TabState[]>([]);
  tabsRef.current = tabs;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const persist = useCallback((list: TabState[]) => {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(list.map((tb) => ({ id: tb.id, shellId: tb.shellId, shellLabel: tb.shellLabel, index: tb.index }))),
      );
    } catch {
      // sessionStorage unavailable (private mode) — non-fatal
    }
  }, []);

  const handleInstance = useCallback((id: string, inst: TerminalInstance | null) => {
    if (inst) instancesRef.current.set(id, inst);
    else instancesRef.current.delete(id);
  }, []);

  const handleStatusChange = useCallback((id: string, status: "running" | "exited") => {
    setTabs((prev) => prev.map((tb) => (tb.id === id ? { ...tb, status } : tb)));
  }, []);

  // Reattach terminals persisted in sessionStorage (page reload keeps them alive).
  useEffect(() => {
    let stored: Array<{ id: string; shellId: string; shellLabel: string; index: number }> = [];
    try {
      stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    } catch {
      stored = [];
    }
    if (!Array.isArray(stored) || stored.length === 0) return;

    void Promise.all(
      stored.map(async (s): Promise<TabState | null> => {
        try {
          const res = await fetch(`/api/terminal/${encodeURIComponent(s.id)}`);
          if (!res.ok) return null;
          const info = (await res.json()) as { status?: string };
          if (info.status !== "running" && info.status !== "exited") return null;
          return { id: s.id, shellId: s.shellId, shellLabel: s.shellLabel, status: info.status, index: s.index };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      const valid = results.filter((r): r is TabState => r !== null);
      nextIndexRef.current = valid.reduce((max, tb) => Math.max(max, tb.index), 0) + 1;
      setTabs(valid);
      setActiveId((cur) => cur ?? valid[0]?.id ?? null);
    });
  }, []);

  const createTab = useCallback(async () => {
    if (!cwd || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const data = (await res.json().catch(() => ({}))) as { session?: TabState & { shell: string; shellLabel: string }; error?: string };
      if (!res.ok || !data.session) throw new Error(data.error ?? `HTTP ${res.status}`);
      const s = data.session;
      const tab: TabState = {
        id: s.id,
        shellId: s.shell,
        shellLabel: s.shellLabel,
        status: s.status,
        index: nextIndexRef.current++,
      };
      setTabs((prev) => {
        const next = [...prev, tab];
        persist(next);
        return next;
      });
      setActiveId(s.id);
    } catch (error) {
      console.error("[terminal] create failed:", error instanceof Error ? error.message : error);
    } finally {
      setBusy(false);
    }
  }, [cwd, busy, persist]);

  const closeTab = useCallback((id: string) => {
    void fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    const prev = tabsRef.current;
    const idx = prev.findIndex((tb) => tb.id === id);
    const next = prev.filter((tb) => tb.id !== id);
    setTabs(next);
    persist(next);
    if (activeIdRef.current === id) {
      setActiveId(next[Math.max(0, idx - 1)]?.id ?? next[0]?.id ?? null);
    }
  }, [persist]);

  const clearTab = useCallback((id: string) => {
    instancesRef.current.get(id)?.term.clear();
    postInput(id, { data: "\x0c" });
  }, []);

  const restartTab = useCallback((id: string) => {
    const prev = tabsRef.current;
    const tab = prev.find((tb) => tb.id === id);
    if (!tab) return;
    void fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    void (async () => {
      try {
        const res = await fetch("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, shell: tab.shellId }),
        });
        const data = (await res.json().catch(() => ({}))) as { session?: { id: string; shell: string; shellLabel: string; status: "running" | "exited" }; error?: string };
        if (!res.ok || !data.session) return;
        const s = data.session;
        const newTab: TabState = { id: s.id, shellId: s.shell, shellLabel: s.shellLabel, status: s.status, index: tab.index };
        setTabs((prevTabs) => {
          const next = prevTabs.map((tb) => (tb.id === id ? newTab : tb));
          persist(next);
          return next;
        });
        setActiveId(s.id);
      } catch (error) {
        console.error("[terminal] restart failed:", error instanceof Error ? error.message : error);
      }
    })();
  }, [cwd, persist]);

  const activeTab = tabs.find((tb) => tb.id === activeId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header: tabs + controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 10px",
          flexShrink: 0,
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
          minHeight: 36,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0, overflowX: "auto", scrollbarWidth: "none" }}>
          {tabs.map((tab) => {
            const isActive = tab.id === activeId;
            return (
              <div
                key={tab.id}
                onClick={() => setActiveId(tab.id)}
                role="tab"
                aria-selected={isActive}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  borderRadius: 6,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  fontSize: 12,
                  background: isActive ? "var(--bg-selected)" : "transparent",
                  color: isActive ? "var(--text)" : "var(--text-muted)",
                  border: "1px solid transparent",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: tab.status === "running" ? "var(--accent)" : "var(--text-dim)",
                  }}
                />
                <span>{tab.shellLabel} {tab.index}</span>
                <button
                  type="button"
                  aria-label={t("terminal.close")}
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 16,
                    height: 16,
                    padding: 0,
                    border: "none",
                    borderRadius: 4,
                    background: "transparent",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="18" y1="6" x2="6" y2="18" />
                  </svg>
                </button>
              </div>
            );
          })}
          <button
            type="button"
            aria-label={t("terminal.new")}
            title={t("terminal.new")}
            disabled={!cwd || busy}
            onClick={() => { void createTab(); }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 24,
              height: 24,
              padding: 0,
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: cwd && !busy ? "pointer" : "not-allowed",
              opacity: cwd && !busy ? 1 : 0.5,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        {/* More menu */}
        <div style={{ position: "relative", flexShrink: 0 }}>
          <button
            type="button"
            aria-label={t("terminal.more")}
            onClick={() => setMenuOpen((v) => !v)}
            disabled={!activeTab}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 24,
              height: 24,
              padding: 0,
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-muted)",
              cursor: activeTab ? "pointer" : "not-allowed",
              opacity: activeTab ? 1 : 0.5,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </button>
          {menuOpen && activeTab && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 60 }} onClick={() => setMenuOpen(false)} />
              <div
                role="menu"
                style={{
                  position: "absolute",
                  right: 0,
                  top: "calc(100% + 4px)",
                  zIndex: 70,
                  minWidth: 150,
                  padding: "4px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
                }}
              >
                {[
                  { key: "clear", label: t("terminal.clear"), run: () => clearTab(activeTab.id) },
                  { key: "restart", label: t("terminal.restart"), run: () => restartTab(activeTab.id) },
                  { key: "close", label: t("terminal.close"), run: () => closeTab(activeTab.id) },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => { setMenuOpen(false); item.run(); }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "6px 9px",
                      borderRadius: 6,
                      border: "none",
                      background: "transparent",
                      color: "var(--text)",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Terminal body */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, background: isDark ? "#1B1D20" : "#F6F6F3" }}>
        {tabs.map((tab) => (
          <TerminalTabView
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            isDark={isDark}
            onStatusChange={handleStatusChange}
            onInstance={handleInstance}
          />
        ))}
        {tabs.length === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
            <div style={{ textAlign: "center", color: "var(--text-dim)", fontSize: 12, lineHeight: 1.7 }}>
              {cwd ? t("terminal.empty") : t("terminal.noCwd")}
            </div>
          </div>
        )}
      </div>

      {/* Status line */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          flexShrink: 0,
          borderTop: "1px solid var(--border)",
          background: "var(--bg-panel)",
          fontSize: 11,
          color: "var(--text-dim)",
        }}
      >
        {activeTab ? (
          <>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: activeTab.status === "running" ? "var(--accent)" : "var(--text-dim)",
              }}
            />
            <span>
              {activeTab.shellLabel} {activeTab.index}
            </span>
            <span style={{ color: "var(--text-muted)" }}>
              {activeTab.status === "running" ? t("terminal.running") : t("terminal.exited")}
            </span>
          </>
        ) : (
          <span>{t("activity.terminal")}</span>
        )}
      </div>
    </div>
  );
}
