import { NextRequest, NextResponse } from "next/server";
import { statSync } from "fs";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { attachUserSeqs } from "@/lib/univer-user-edits";
import { runUniver } from "@/lib/univer-cli";
import { openUniverDb } from "@/lib/univer-db";


interface WorktreeInfo {
  id: string;
  status: string;
  name: string;
  headCommit: number;
  commits: Array<{ seq: number; message: string; createdAt: string }>;
  /** Worktree creation time (ISO) — lets the UI sort even before first commit. */
  createdAt?: string;
}

/**
 * Reads the worktree list + commit history straight from the .univer SQLite
 * database (seconds), falling back to spawning the CLI only if the DB is
 * unreadable. Mirrors `univer-cli`'s worktree-units sidebar data.
 */
export async function GET(request: NextRequest) {
  try {
    const file = request.nextUrl.searchParams.get("file")?.trim() ?? "";
    if (!file.toLowerCase().endsWith(".univer")) {
      return NextResponse.json({ error: "file must be a .univer file" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(file, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const worktrees = readWorktreesFromDb(file) ?? await readWorktreesFromCli(file);
    if (!worktrees) {
      return NextResponse.json({ error: "Could not read worktrees" }, { status: 500 });
    }

    // Tag commits created by online user edits (see /api/univer/edit-commit) so
    // the UI can label them "u{seq}" instead of "r{seq}".
    attachUserSeqs(file, worktrees);

    // Trunk content revision = file mtime (trunk only changes on merges, which
    // rewrite the file). Lets the frontend cache parsed trunk data per revision
    // so merges refresh the grid without a full reload.
    let trunkRev = 0;
    try {
      trunkRev = statSync(file).mtimeMs;
    } catch {
      // file may have been removed between the checks — keep 0
    }

    return NextResponse.json({ ok: true, worktrees, trunkRev });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

interface SqlWorktree {
  worktree_id: string;
  status: string;
  name: string | null;
  head_commit: number;
  created_at_ms: number;
}

// Auto-save staging worktrees (trunk online edits) are hidden from the list so
// the UI doesn't reload on every auto-save and the list stays clean.
function isHiddenWorktree(name: string | null): boolean {
  return typeof name === "string" && name.startsWith("pi-auto");
}
interface SqlCommit {
  seq: number;
  message: string | null;
  created_at_ms: number;
}

function readWorktreesFromDb(file: string): WorktreeInfo[] | null {
  try {
    const db = openUniverDb(file, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT worktree_id, status, name, head_commit, created_at_ms FROM collaboration_worktrees ORDER BY created_at_ms")
        .all() as unknown as SqlWorktree[];
      const commitStmt = db.prepare(
        "SELECT seq, message, created_at_ms FROM collaboration_worktree_commits WHERE worktree_id = ? ORDER BY seq",
      );
      return rows
        .filter((w) => !isHiddenWorktree(w.name))
        .map((w) => ({
          id: w.worktree_id,
          status: w.status,
          name: w.name ?? "",
          headCommit: w.head_commit,
          createdAt: new Date(w.created_at_ms).toISOString(),
          commits: (commitStmt.all(w.worktree_id) as unknown as SqlCommit[]).map((c) => ({
            seq: c.seq,
            message: c.message ?? "",
            createdAt: new Date(c.created_at_ms).toISOString(),
          })),
        }));
    } finally {
      db.close();
    }
  } catch {
    return null; // not a readable univer DB — fall back to the CLI
  }
}

async function readWorktreesFromCli(file: string): Promise<WorktreeInfo[] | null> {
  try {
    const stdout = await runUniver(["worktree", "list", file, "--json"]);
    const parsed = JSON.parse(stdout) as {
      worktrees?: Array<{ worktreeId: string; status: string; name?: string; headCommit?: number }>;
    };

    const worktrees: WorktreeInfo[] = [];
    for (const wt of parsed.worktrees ?? []) {
      if (isHiddenWorktree(wt.name ?? null)) continue;
      let commits: WorktreeInfo["commits"] = [];
      try {
        const logOut = await runUniver(["worktree", "log", file, "--worktree", wt.worktreeId, "--json"]);
        const logParsed = JSON.parse(logOut) as { commits?: Array<{ seq: number; message?: string; createdAt?: string }> };
        commits = (logParsed.commits ?? []).map((c) => ({
          seq: c.seq,
          message: c.message ?? "",
          createdAt: c.createdAt ?? "",
        }));
      } catch { /* worktree may be gone — skip log */ }

      worktrees.push({
        id: wt.worktreeId,
        status: wt.status,
        name: wt.name ?? "",
        headCommit: wt.headCommit ?? 0,
        commits,
      });
    }
    return worktrees;
  } catch {
    return null;
  }
}

// reload-check-1
