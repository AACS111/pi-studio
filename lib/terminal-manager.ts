import { resolveShell, TerminalSession } from "./terminal-session";

declare global {
  var __piTerminalManager: TerminalManager | undefined;
}

/** Cap concurrent shells so a misbehaving client can't fork endlessly. */
const MAX_SESSIONS = 8;

export interface CreateTerminalOutcome {
  session?: TerminalSession;
  error?: string;
}

/**
 * In-process registry of terminal sessions (one PTY each), stored on
 * globalThis so it survives Next.js hot-reload. Both browser mode and the
 * Electron desktop shell run the Next server as a plain Node process, so a
 * PTY spawned here works identically in every mode and can later be reused by
 * the Agent's bash tool (same process → direct function call).
 */
export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  create(
    cwd: string,
    options: { shellId?: string; cols?: number; rows?: number } = {},
  ): CreateTerminalOutcome {
    const alive = this.getAll().filter((session) => session.isAlive());
    if (alive.length >= MAX_SESSIONS) {
      return { error: `At most ${MAX_SESSIONS} terminals can run at once` };
    }
    const shell = resolveShell(options.shellId);
    const session = new TerminalSession(cwd, shell, options.cols, options.rows);
    this.sessions.set(session.id, session);
    return { session };
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  getAll(): TerminalSession[] {
    return [...this.sessions.values()];
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.isAlive()) return false;
    session.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.isAlive()) return false;
    session.resize(cols, rows);
    return true;
  }

  /** Restart a terminal in place (same cwd + shell). Returns the new session. */
  restart(id: string): TerminalSession | undefined {
    const old = this.sessions.get(id);
    if (!old) return undefined;
    const cwd = old.cwd;
    const shell = old.shell;
    const cols = old.getCols();
    const rows = old.getRows();
    old.kill();
    this.sessions.delete(id);
    const session = new TerminalSession(cwd, shell, cols, rows);
    this.sessions.set(session.id, session);
    return session;
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill();
    this.sessions.delete(id);
    return true;
  }

  destroyAll(): void {
    for (const session of this.getAll()) session.kill();
    this.sessions.clear();
  }
}

export function getTerminalManager(): TerminalManager {
  if (!globalThis.__piTerminalManager) {
    globalThis.__piTerminalManager = new TerminalManager();
    const cleanup = () => globalThis.__piTerminalManager?.destroyAll();
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piTerminalManager;
}
