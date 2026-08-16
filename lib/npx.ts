import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { dirname, join, delimiter } from "path";
import { execPath } from "process";

const execFileAsync = promisify(execFile);

/**
 * Resolve the real Node.js executable.
 *
 * Under Electron (`dev:electron` / packaged), the Next.js server is spawned by
 * the Electron binary with `ELECTRON_RUN_AS_NODE=1`, so `process.execPath` is
 * `electron.exe` — NOT node. Running dsh under electron-as-node breaks dsh's
 * Cordis plugin loader, and searching for npm/npx next to it fails, so the
 * `.cmd` fallback then throws `spawn EINVAL` on Windows. Prefer the real node
 * via `npm_node_execpath`, then PATH, and only use `execPath` as a last resort.
 */
export function resolveNodeExecutable(): string {
  // npm injects the real node path when it launches scripts.
  const fromEnv = process.env.npm_node_execpath;
  if (fromEnv && fromEnv.trim()) {
    try {
      if (existsSync(fromEnv)) return fromEnv;
    } catch {
      // ignore
    }
  }
  // If execPath is already real node (not electron), use it.
  const exe = execPath.toLowerCase();
  if (!exe.includes("electron")) return execPath;
  // Electron-as-node: find the real node on PATH.
  const onPath = findNodeOnPath();
  if (onPath) return onPath;
  return execPath;
}

function findNodeOnPath(): string | null {
  const pathVar = process.env.PATH || process.env.Path || "";
  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/**
 * Locate `npx-cli.js` / `npm-cli.js` shipped with a Node.js installation.
 * The real `npx`/`npm` on PATH are `.cmd` shims on Windows, which Node refuses
 * to spawn without a shell (CVE-2024-27980). We find the real JS entry and run
 * it via node, which works on every platform and needs no shell.
 */
function findNpmBinScript(name: "npx-cli.js" | "npm-cli.js", nodeDir: string): string | null {
  const candidates = [
    // Windows MSI installer layout: node.exe and node_modules share a dir
    join(nodeDir, "node_modules", "npm", "bin", name),
    // Unix layout: .../bin/node + .../lib/node_modules/npm/bin/npx-cli.js
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", name),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

function findNpxCli(): string | null {
  return findNpmBinScript("npx-cli.js", dirname(resolveNodeExecutable()));
}

function findNpmCli(): string | null {
  // npm_execpath points at the npm-cli.js when launched via the npm lifecycle.
  const fromEnv = process.env.npm_execpath;
  if (fromEnv) {
    try {
      if (existsSync(fromEnv)) return fromEnv;
    } catch {
      // ignore
    }
  }
  return findNpmBinScript("npm-cli.js", dirname(resolveNodeExecutable()));
}

export interface RunNpxOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunNpxResult {
  stdout: string;
  stderr: string;
}

/**
 * Resolve the cross-platform npx invocation for `npx <args>` without a shell.
 * Returns the real `npx-cli.js` (run via the current node binary) when found,
 * otherwise falls back to `npx`.
 */
export function resolveNpxInvocation(args: string[]): { command: string; commandArgs: string[] } {
  const npxCli = findNpxCli();
  return npxCli
    ? { command: resolveNodeExecutable(), commandArgs: [npxCli, ...args] }
    : { command: "npx", commandArgs: args };
}

/**
 * Resolve the cross-platform npm invocation for `npm <args>`. Prefers the real
 * `npm-cli.js` run via node; otherwise falls back to `npm`/`npm.cmd` on PATH.
 * When `useShell` is true the caller must spawn with a shell (Windows .cmd).
 */
export function resolveNpmInvocation(args: string[]): {
  command: string;
  commandArgs: string[];
  useShell: boolean;
} {
  const npmCli = findNpmCli();
  if (npmCli) {
    return {
      command: resolveNodeExecutable(),
      commandArgs: [npmCli, ...args],
      useShell: false,
    };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    commandArgs: args,
    useShell: true,
  };
}

/**
 * Cross-platform wrapper for invoking `npx <args>` without ever using a
 * shell, so user-controlled arguments are never interpreted as shell syntax.
 */
export async function runNpx(args: string[], opts: RunNpxOptions = {}): Promise<RunNpxResult> {
  const { command, commandArgs } = resolveNpxInvocation(args);
  return execFileAsync(command, commandArgs, {
    timeout: opts.timeout,
    cwd: opts.cwd,
    env: opts.env,
    // On Windows the app has no console; without this, every npx invocation
    // flashes a node.exe console window.
    windowsHide: true,
  });
}
