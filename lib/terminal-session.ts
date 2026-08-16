import { spawn } from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { basename } from "path";

// ============================================================================
// Types
// ============================================================================

export interface ShellInfo {
  id: string;
  label: string;
  command: string;
  args: string[];
}

export type TerminalStatus = "running" | "exited";

export type TerminalEvent =
  | { type: "data"; data: string }
  | { type: "status"; status: TerminalStatus; exitCode?: number | null };

// ============================================================================
// Tuning
// ============================================================================

/** Ring buffer keeps the last ~256KB so late joiners (page reload / reconnect)
 *  see recent output without unbounded memory growth. */
const MAX_RING_BUFFER_BYTES = 256 * 1024;
/** After the last SSE subscriber disconnects, kill the PTY after this grace
 *  period so closing the browser tab cleans up orphaned shells. */
const NO_SUBSCRIBER_GRACE_MS = 5 * 60 * 1000;
/** Hard cap: a terminal fully idle (no input nor output) this long is killed
 *  even if a subscriber is still attached. */
const HARD_IDLE_MS = 60 * 60 * 1000;

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

// ============================================================================
// Shell detection (cached; pwsh → powershell → cmd → git-bash on Windows)
// ============================================================================

const commandExistsCache = new Map<string, boolean>();

function commandExists(command: string): boolean {
  const cached = commandExistsCache.get(command);
  if (cached !== undefined) return cached;
  let found = false;
  try {
    if (process.platform === "win32") {
      execSync(`where ${command}`, { stdio: "ignore", shell: "cmd.exe" });
    } else {
      execSync(`command -v ${command}`, { stdio: "ignore", shell: "/bin/sh" });
    }
    found = true;
  } catch {
    found = false;
  }
  commandExistsCache.set(command, found);
  return found;
}

let shellsCache: ShellInfo[] | null = null;

export function getAvailableShells(): ShellInfo[] {
  if (shellsCache) return shellsCache;
  const shells: ShellInfo[] = [];
  if (process.platform === "win32") {
    if (commandExists("pwsh")) {
      shells.push({ id: "pwsh", label: "PowerShell", command: "pwsh.exe", args: ["-NoLogo", "-NoProfile", "-NoExit"] });
    }
    if (commandExists("powershell")) {
      shells.push({ id: "powershell", label: "Windows PowerShell", command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NoExit"] });
    }
    if (commandExists("cmd")) {
      shells.push({ id: "cmd", label: "Command Prompt", command: "cmd.exe", args: [] });
    }
    if (commandExists("bash")) {
      shells.push({ id: "bash", label: "Git Bash", command: "bash.exe", args: ["--login", "-i"] });
    }
  } else {
    const shellPath = process.env.SHELL || "/bin/bash";
    const name = basename(shellPath) || "bash";
    shells.push({ id: name, label: name, command: shellPath, args: [] });
  }
  shellsCache = shells;
  return shells;
}

export function resolveShell(shellId?: string): ShellInfo {
  const shells = getAvailableShells();
  if (shellId) {
    const found = shells.find((shell) => shell.id === shellId);
    if (found) return found;
  }
  return shells[0] ?? { id: "sh", label: "sh", command: "/bin/sh", args: [] };
}

// ============================================================================
// TerminalSession — one shell PTY, one SSE fan-out
// ============================================================================

export class TerminalSession {
  readonly id: string;
  readonly shell: ShellInfo;
  readonly cwd: string;
  private pty: IPty | null = null;
  private status: TerminalStatus = "running";
  private exitCode: number | null = null;
  private bufferChunks: string[] = [];
  private bufferBytes = 0;
  private listeners = new Set<(event: TerminalEvent) => void>();
  private subscriberCount = 0;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private cols: number;
  private rows: number;

  constructor(cwd: string, shell: ShellInfo, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    this.id = randomUUID();
    this.cwd = cwd;
    this.shell = shell;
    this.cols = cols;
    this.rows = rows;
    this.spawnPty();
    this.resetIdleTimer();
  }

  private spawnPty(): void {
    const cwd = existsSync(this.cwd) ? this.cwd : homedir();
    const pty = spawn(this.shell.command, this.shell.args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    this.pty = pty;

    pty.onData((data) => {
      this.resetIdleTimer();
      this.pushBuffer(data);
      this.broadcast({ type: "data", data });
    });

    pty.onExit(({ exitCode }) => {
      this.status = "exited";
      this.exitCode = exitCode;
      this.pty = null;
      this.clearIdleTimer();
      this.broadcast({ type: "status", status: "exited", exitCode });
    });

    // Windows PowerShell 5.1 pipes output through the OEM codepage (GBK on
    // Chinese Windows) unless forced to UTF-8. PowerShell 7 already defaults
    // to UTF-8, but the init line is harmless there.
    if (this.shell.id === "powershell") {
      pty.write("[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::InputEncoding=[Text.Encoding]::UTF8;\r");
    }
  }

  getStatus(): TerminalStatus {
    return this.status;
  }

  getExitCode(): number | null {
    return this.exitCode;
  }

  getCols(): number {
    return this.cols;
  }

  getRows(): number {
    return this.rows;
  }

  isAlive(): boolean {
    return this.status === "running" && this.pty !== null;
  }

  getBufferedOutput(): string {
    return this.bufferChunks.join("");
  }

  getSubscriberCount(): number {
    return this.subscriberCount;
  }

  write(data: string): void {
    if (!this.pty) return;
    this.resetIdleTimer();
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.pty) return;
    this.cols = Math.max(2, Math.min(500, Math.round(cols)));
    this.rows = Math.max(2, Math.min(200, Math.round(rows)));
    try {
      this.pty.resize(this.cols, this.rows);
    } catch {
      // Resize after exit is a no-op.
    }
  }

  kill(): void {
    this.clearIdleTimer();
    this.clearGraceTimer();
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        // Already dead.
      }
    }
    this.pty = null;
  }

  subscribe(listener: (event: TerminalEvent) => void): () => void {
    this.listeners.add(listener);
    this.subscriberCount++;
    this.clearGraceTimer();
    return () => {
      this.listeners.delete(listener);
      this.subscriberCount--;
      if (this.subscriberCount <= 0 && this.isAlive()) this.startGraceTimer();
    };
  }

  private broadcast(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors — a broken SSE consumer must not kill the PTY.
      }
    }
  }

  private pushBuffer(data: string): void {
    this.bufferChunks.push(data);
    this.bufferBytes += data.length;
    while (this.bufferBytes > MAX_RING_BUFFER_BYTES && this.bufferChunks.length > 1) {
      const dropped = this.bufferChunks.shift();
      if (dropped) this.bufferBytes -= dropped.length;
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isAlive()) this.kill();
    }, HARD_IDLE_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private startGraceTimer(): void {
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      if (this.subscriberCount <= 0 && this.isAlive()) this.kill();
    }, NO_SUBSCRIBER_GRACE_MS);
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }
}
