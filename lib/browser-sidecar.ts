import { spawn } from "child_process";
import { createConnection } from "net";
import { existsSync, mkdirSync, openSync } from "fs";
import { join } from "path";

/**
 * Browser-use sidecar (tools/browser-use-server/server.py, FastAPI on 127.0.0.1:17865)
 * auto-start helper.
 *
 * The sidecar drives a real headless Chrome (via browser-use/CDP) so the agent can
 * open pages, click, type, scroll, screenshot, and extract page markdown. It is NOT
 * started automatically by next itself — this module lets the boot hook
 * (instrumentation.ts) bring it up alongside the univer daemon warm-up.
 *
 * Idempotent + failure-tolerant: if 17865 is already listening, or the venv is
 * missing, or spawn fails, this silently returns. Boot must never fail because of it.
 */

const SIDECAR_PORT = Number(process.env.PI_BROWSER_USE_PORT ?? "17865");
const SIDECAR_DIR = join(process.cwd(), "tools", "browser-use-server");

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

/**
 * Fire-and-forget sidecar start for boot hooks. Never rejects.
 * Skips when the port is already served; otherwise spawns the venv python detached
 * with stdout/stderr appended to server-console.log (server.py also writes server.log).
 *
 * Windows: delegates to start.bat, which uses `start` to create a brand-new console
 * window for the sidecar. A bare `node spawn(detached)` on Windows leaves the child
 * attached to the caller's console session — when that session ends the sidecar's
 * listening socket dies with `WinError 64 (指定的网络名不再可用)`.
 */
export async function ensureBrowserSidecar(): Promise<void> {
  try {
    if (await isListening(SIDECAR_PORT)) return; // already running

    if (process.platform === "win32") {
      const bat = join(SIDECAR_DIR, "start.bat");
      if (!existsSync(bat)) return;
      // start.bat is idempotent (re-checks the port) and spawns an independent
      // console via `start`, so the sidecar survives this process's lifetime.
      const cmd = spawn("cmd.exe", ["/c", bat], {
        cwd: SIDECAR_DIR,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      cmd.unref();
      return;
    }

    const python = resolveVenvPython();
    if (!python) return; // venv not set up — user can run start.bat manually

    const logPath = join(SIDECAR_DIR, "server-console.log");
    mkdirSync(SIDECAR_DIR, { recursive: true });
    const out = openSync(logPath, "a");

    const child = spawn(python, [join(SIDECAR_DIR, "server.py")], {
      cwd: SIDECAR_DIR,
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}
