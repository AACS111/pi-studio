import { spawn, type ChildProcess } from "child_process";
import { createConnection } from "net";
import { request as httpRequest } from "http";
import { existsSync, mkdirSync, openSync } from "fs";
import { join } from "path";

/**
 * Browser-use sidecar (tools/browser-use-server/server.py, FastAPI on 127.0.0.1:17865)
 * auto-start helper.
 *
 * The sidecar drives a real headless Chrome (via browser-use/CDP) so the agent can
 * open pages, click, type, scroll, screenshot, and extract page markdown.
 *
 * Lifecycle model (as the user wants): the sidecar is a *background child process*
 * of pi-studio itself —
 *   - started automatically by the boot hook (instrumentation.ts) with npm run dev /
 *     next start / the packaged app;
 *   - no console window (windowsHide + stdio redirected to server-console.log);
 *   - NOT detached: keeps the parent/child relationship, and exit hooks
 *     (SIGINT/SIGTERM/exit) kill the sidecar together with pi-studio.
 *
 * Why not start.bat: it uses `start` to create a brand-new console window, which
 * stays visible and keeps the sidecar alive after pi-studio exits. Why not a bare
 * detached spawn: on Windows the child loses its console session when the caller
 * exits and its listening socket dies with `WinError 64 (指定的网络名不再可用)`.
 *
 * Idempotent + failure-tolerant: if 17865 is already listening, or the venv is
 * missing, or spawn fails, this silently returns. Boot must never fail because of it.
 */

const SIDECAR_PORT = Number(process.env.PI_BROWSER_USE_PORT ?? "17865");
const SIDECAR_DIR = join(process.cwd(), "tools", "browser-use-server");

/** globalThis keeps the child ref alive across Next.js hot reloads. */
const GLOBAL_KEY = "__piStudioBrowserSidecar";
interface SidecarState {
  child: ChildProcess | null;
  hooksRegistered: boolean;
  healthTimer: ReturnType<typeof setInterval> | null;
}
function getState(): SidecarState {
  const g = globalThis as unknown as Record<string, SidecarState>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { child: null, hooksRegistered: false, healthTimer: null };
  return g[GLOBAL_KEY];
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1200);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/** HTTP-level probe: a live TCP listener is not enough — the sidecar's asyncio
 *  loop can wedge (WinError 10054/64) leaving the port half-open. Only a real
 *  request round-trip proves the app is responsive. */
function isHttpAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/url", method: "GET", timeout: 2500 },
      (res) => {
        res.resume();
        resolve(true); // any HTTP response (even 4xx/5xx) means the app is alive
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

function resolveVenvPython(): string | null {
  const win = join(SIDECAR_DIR, ".venv", "Scripts", "python.exe");
  const unix = join(SIDECAR_DIR, ".venv", "bin", "python");
  const candidate = process.platform === "win32" ? win : unix;
  return existsSync(candidate) ? candidate : null;
}

/** Kill the sidecar when pi-studio shuts down (Ctrl+C, termination, or normal exit). */
function registerShutdownHooks(state: SidecarState): void {
  if (state.hooksRegistered) return;
  state.hooksRegistered = true;
  const stop = () => {
    const child = state.child;
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
    }
  };
  process.on("exit", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/**
 * Watch the sidecar's HTTP endpoint. If the port accepts TCP but the app stops
 * answering (wedged asyncio loop), kill the child and let ensureBrowserSidecar
 * relaunch it. Self-healing keeps the agent browser usable across day-long dev
 * sessions without manual restarts.
 */
function startHealthCheck(state: SidecarState): void {
  if (state.healthTimer) return;
  state.healthTimer = setInterval(async () => {
    try {
      const child = state.child;
      const dead = !child || child.killed || child.exitCode !== null;
      if (dead) {
        // Child is gone (crashed / killed externally / wedged then killed by us).
        // Give the port a moment to release, then relaunch.
        state.child = null;
        await new Promise((r) => setTimeout(r, 1500));
        await ensureBrowserSidecar();
        return;
      }
      const alive = await isHttpAlive(SIDECAR_PORT);
      if (alive) return;
      logWarn("browser-use sidecar unresponsive — restarting");
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      state.child = null;
      await new Promise((r) => setTimeout(r, 1500));
      await ensureBrowserSidecar();
    } catch {
      /* best-effort */
    }
  }, 15000);
  // Never keep the process alive solely because of the watchdog.
  state.healthTimer.unref?.();
}

function logWarn(msg: string): void {
  try {
    console.warn(`[pi-studio] ${msg}`);
  } catch {
    /* best-effort */
  }
}

/**
 * Fire-and-forget sidecar start for boot hooks. Never rejects.
 * Skips when the port is already served. Spawns the venv python as a windowless
 * child of this process and ties its lifetime to pi-studio.
 */
export async function ensureBrowserSidecar(): Promise<void> {
  try {
    // 打包后的桌面应用使用 Electron 原生 WebContentsView 控制桥，
    // 不再需要独立 Python 侧车（main.cjs 会设置 PI_BROWSER_USE_BASE_URL）。
    if (process.env.PI_BROWSER_USE_BASE_URL) return;
    if (await isListening(SIDECAR_PORT)) return; // already running
    const python = resolveVenvPython();
    if (!python) return; // venv not set up — user can run start.bat manually

    const state = getState();
    registerShutdownHooks(state);

    const logPath = join(SIDECAR_DIR, "server-console.log");
    mkdirSync(SIDECAR_DIR, { recursive: true });
    const out = openSync(logPath, "a");

    // NOT detached: keep the child in our process group so shutdown hooks can
    // terminate it together with pi-studio. stdio goes to the log file, and
    // windowsHide prevents any console window.
    const child = spawn(python, [join(SIDECAR_DIR, "server.py")], {
      cwd: SIDECAR_DIR,
      detached: false,
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    state.child = child;
    startHealthCheck(state);
  } catch {
    /* best-effort */
  }
}
