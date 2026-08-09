import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import { getInternalDir } from "./storage-config";

const execFileAsync = promisify(execFile);

/**
 * pi-studio owns a dedicated univer daemon at this runtime root.
 *
 * The global `univer` CLI (used from the terminal / skills) shares the default
 * runtime root (~/.univer) with any install that doesn't override it — but the
 * project-pinned and global installs resolve slightly different insider
 * dependencies, so their daemon build hashes differ and they reject each
 * other's clients ("Daemon build mismatch"). Pointing every pi-studio subprocess
 * at its own UNIVER_HOME isolates the two completely: pi-studio's daemon is
 * started/owned by pi-studio, the terminal CLI keeps its own at ~/.univer.
 * The home lives in pi-studio's data dir (.internal/univer, default
 * <project>/pi-web-uploads/.internal — configurable via lib/storage-config.ts).
 */
const PI_WEB_UNIVER_HOME = join(getInternalDir(), "univer");

function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, UNIVER_HOME: PI_WEB_UNIVER_HOME };
}

/**
 * Shared `univer` CLI runner for server routes.
 *
 * Why not `execFileAsync("univer", args, { shell: true })` (the old pattern)?
 * On Windows `univer` resolves to `univer.cmd`, which cmd.exe re-parses: file
 * paths containing spaces or parentheses (e.g. `hello (3).xlsx`) get split into
 * separate arguments and the CLI fails with `invalid-univerfile-path`. Instead
 * we resolve the CLI's real JS entry (`node_modules/univer-cli/bin/univer.js`)
 * and invoke it directly via the current `node` process — no shell, no quoting
 * pitfalls, args pass through verbatim.
 *
 * Integration model (univer-cli is an obfuscated, closed-source Pro CLI with no
 * library exports — it cannot be required in-process, so pi-studio hosts it as its
 * execution backend):
 *  - Entry resolution prefers a project-pinned install
 *    (`<project>/node_modules/univer-cli/bin/univer.js`), then falls back to
 *    the global install (where/which shim → npm root -g → npm_config_prefix).
 *  - First call per process warms the daemon (`daemon start`, idempotent ~2s)
 *    under a shared lock, so concurrent first commands serialize instead of
 *    racing the cold start ("Runner exited before ready" / SIGTERM class).
 *  - `runUniver` still retries once as a safety net for genuine cold starts.
 */
declare global {
  var __univerCliEntry: string | undefined;
  var __univerWarmPromise: Promise<void> | undefined;
}

/** Project-pinned install (when univer-cli is added to package.json). */
function univerJsFromProject(): string | null {
  const js = join(process.cwd(), "node_modules", "univer-cli", "bin", "univer.js");
  return existsSync(js) ? js : null;
}

function univerJsFromShimDir(shimDir: string): string | null {
  const js = join(shimDir, "node_modules", "univer-cli", "bin", "univer.js");
  return existsSync(js) ? js : null;
}

async function resolveUniverCliEntry(): Promise<string> {
  if (globalThis.__univerCliEntry) return globalThis.__univerCliEntry;

  const candidates: string[] = [];

  // 0) Project-pinned install first (deterministic version; ships with the repo)
  const projectEntry = univerJsFromProject();
  if (projectEntry) candidates.push(projectEntry);

  // 1) `where univer` / `which univer` → shim dir → node_modules/univer-cli/bin/univer.js
  if (candidates.length === 0) {
    const whereCmd = process.platform === "win32" ? "where" : "which";
    try {
      const { stdout } = await execFileAsync(whereCmd, ["univer"], { windowsHide: true, timeout: 15_000 });
      for (const line of stdout.split(/\r?\n/)) {
        const shim = line.trim();
        if (!shim) continue;
        const shimDir = dirname(shim);
        const direct = univerJsFromShimDir(shimDir);
        if (direct) {
          candidates.push(direct);
          break;
        }
        // pnpm/bun shims just forward to the real entry; parse the JS path out of
        // the .cmd/.bat content (pattern: "%dp0%\node_modules\univer-cli\bin\univer.js").
        if (/\.(cmd|bat)$/i.test(shim)) {
          try {
            const content = readFileSync(shim, "utf8");
            const match = content.match(/"([^"]*univer-cli[\\/]bin[\\/]univer\.js)"/i);
            if (match) {
              const jsPath = match[1].replace(/%dp0%/gi, shimDir);
              if (existsSync(jsPath)) {
                candidates.push(jsPath);
                break;
              }
            }
          } catch {
            /* unreadable shim — keep trying other candidates */
          }
        }
      }
    } catch {
      /* where/which failed — fall through to npm root -g */
    }
  }

  // 2) npm root -g
  if (candidates.length === 0) {
    try {
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      const { stdout } = await execFileAsync(npmCmd, ["root", "-g"], { windowsHide: true, timeout: 15_000 });
      const root = stdout.trim();
      if (root) {
        const js = join(root, "univer-cli", "bin", "univer.js");
        if (existsSync(js)) candidates.push(js);
      }
    } catch {
      /* npm unavailable */
    }
  }

  // 3) npm_config_prefix
  if (candidates.length === 0 && process.env.npm_config_prefix) {
    const js = join(process.env.npm_config_prefix, "node_modules", "univer-cli", "bin", "univer.js");
    if (existsSync(js)) candidates.push(js);
  }

  const entry = candidates[0];
  if (!entry) {
    throw new Error("univer CLI not found — install it with: npm install -g univer-cli");
  }
  globalThis.__univerCliEntry = entry;
  return entry;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Warm the univer daemon exactly once per process, under a shared promise so
 * concurrent first commands serialize instead of racing the cold start.
 * `daemon start` is idempotent (returns the same pid when already running).
 * A failure here is deliberately swallowed — the command's own retry loop is
 * the safety net, we never want warm-up to fail a user command.
 */
async function ensureDaemonWarm(entry: string): Promise<void> {
  if (!globalThis.__univerWarmPromise) {
    globalThis.__univerWarmPromise = execFileAsync(process.execPath, [entry, "daemon", "start"], {
      windowsHide: true,
      timeout: 60_000,
      env: cliEnv(),
    })
      .then(() => undefined)
      .catch(() => {
        // allow a later call to retry warm-up (daemon may have been mid-restart)
        globalThis.__univerWarmPromise = undefined;
      });
  }
  await globalThis.__univerWarmPromise;
}

const DAEMON_STALE_ERRORS = ["Daemon build mismatch", "Daemon distribution identity is missing"];

/**
 * Stop pi-studio's own daemon so a fresh one can start with the build hash the
 * resolved entry expects. A stale daemon from an older/different univer-cli
 * install may not answer `daemon stop` at all (its meta lacks the distribution
 * identity), so we also kill it via the pid file the daemon writes at startup
 * and remove its stale runtime files — a fresh `daemon start` recreates them.
 * Never throws.
 */
async function stopDaemon(entry: string): Promise<void> {
  const daemonDir = join(PI_WEB_UNIVER_HOME, "daemon");
  // 1) Graceful stop (works when the daemon is the same protocol generation).
  try {
    await execFileAsync(process.execPath, [entry, "daemon", "stop"], {
      windowsHide: true,
      timeout: 30_000,
      env: cliEnv(),
    });
  } catch {
    /* fall through to pid kill + file cleanup */
  }
  // 2) Hard kill via the pid the daemon wrote at startup.
  try {
    const pid = Number(readFileSync(join(daemonDir, "daemon.pid"), "utf8").trim());
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid);
      } catch {
        /* already dead */
      }
    }
  } catch {
    /* no pid file — nothing left to kill */
  }
  // 3) Remove stale runtime files so a fresh `daemon start` can't pick them up.
  for (const name of ["daemon.lock", "daemon.meta.json", "daemon.pid"]) {
    try {
      rmSync(join(daemonDir, name), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run a `univer` command and return stdout.
 *
 * The first call per process warms the daemon (~2-3s, once). Retries once by
 * default as a safety net for genuine cold starts / daemon restarts.
 *
 * Self-heals a stale daemon left over from an older or different univer-cli
 * install ("Daemon build mismatch" / "Daemon distribution identity is
 * missing"): retrying against it can never succeed, so the daemon is stopped,
 * its stale runtime files removed, and the warm promise cleared, then the next
 * attempt starts a fresh daemon built by the entry we actually resolve (and the
 * command is retried immediately).
 */
export async function runUniver(args: string[], options: { retries?: number; signal?: AbortSignal } = {}): Promise<string> {
  const entry = await resolveUniverCliEntry();
  const retries = options.retries ?? 1;
  let lastError: unknown;
  let stoppedForMismatch = false;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await ensureDaemonWarm(entry);
      const { stdout } = await execFileAsync(process.execPath, [entry, ...args], {
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        env: cliEnv(),
        signal: options.signal,
      });
      return stdout;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const message = error instanceof Error ? error.message : String(error);
        if (!stoppedForMismatch && DAEMON_STALE_ERRORS.some((m) => message.includes(m))) {
          stoppedForMismatch = true;
          await stopDaemon(entry);
          globalThis.__univerWarmPromise = undefined;
          continue; // restart the daemon on the next attempt — no pointless sleep
        }
        await sleep(800);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Public, failure-tolerant daemon warm-up for boot hooks (instrumentation.ts).
 * Fire-and-forget: never rejects, so boot can't fail because of it.
 */
export async function warmUpUniverDaemon(): Promise<void> {
  try {
    const entry = await resolveUniverCliEntry();
    await ensureDaemonWarm(entry);
  } catch {
    /* warm-up is best-effort */
  }
}
