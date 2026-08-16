import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { getTerminalManager } from "@/lib/terminal-manager";
import { getAvailableShells, type TerminalSession } from "@/lib/terminal-session";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

function toSessionInfo(session: TerminalSession) {
  return {
    id: session.id,
    shell: session.shell.id,
    shellLabel: session.shell.label,
    cwd: session.cwd,
    status: session.getStatus(),
    exitCode: session.getExitCode(),
    cols: session.getCols(),
    rows: session.getRows(),
  };
}

// GET /api/terminal — available shells + live session list (page reload reattach)
export async function GET() {
  const manager = getTerminalManager();
  return NextResponse.json({
    shells: getAvailableShells(),
    sessions: manager.getAll().map(toSessionInfo),
  });
}

// POST /api/terminal — create a terminal session
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const rawCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const shellId = typeof body.shell === "string" ? body.shell : undefined;
  const cols = typeof body.cols === "number" ? body.cols : 100;
  const rows = typeof body.rows === "number" ? body.rows : 30;

  let cwd = rawCwd;
  if (cwd) {
    try {
      cwd = resolve(cwd);
    } catch {
      cwd = "";
    }
  }

  if (!cwd || !existsSync(cwd)) {
    cwd = homedir();
  } else {
    // Consistent with the rest of the app: the starting cwd must be inside the
    // allowed roots (session cwds, project roots, uploads store, …). The shell
    // itself can still `cd` anywhere — this only guards the spawn point.
    const roots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, roots)) {
      return NextResponse.json({ error: "Directory is not within the allowed roots" }, { status: 403 });
    }
  }

  const manager = getTerminalManager();
  const result = manager.create(cwd, { shellId, cols, rows });
  if (result.error || !result.session) {
    return NextResponse.json({ error: result.error ?? "Failed to create terminal" }, { status: 429 });
  }
  return NextResponse.json({ session: toSessionInfo(result.session) }, { status: 201 });
}
