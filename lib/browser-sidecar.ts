import { spawn, type ChildProcess } from "child_process";
import { createConnection } from "net";
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
}
function getState(): SidecarState {
  const g = globalThis as unknown as Record<string, SidecarState>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { child: null, hooksRegistered: false };
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
 * Fire-and-forget sidecar start for boot hooks. Never rejects.
 * Skips when the port is already served. Spawns the venv python as a windowless
 * child of this process and ties its lifetime to pi-studio.
 */
export async function ensureBrowserSidecar(): Promise<void> {
  try {
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
  } catch {
    /* best-effort */
  }
}
