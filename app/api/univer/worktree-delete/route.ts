import { NextRequest, NextResponse } from "next/server";
import type { DatabaseSync } from "node:sqlite";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { removeUserEdits } from "@/lib/univer-user-edits";
import { openUniverDb } from "@/lib/univer-db";

// All worktree-scoped tables in the .univer SQLite DB; deleted together so the
// record disappears cleanly. The CLI has no `worktree delete` command, so this
// is the only way to remove a stale record. Merged worktrees are protected —
// they are the durable merge history.
const WORKTREE_TABLES = [
  "collaboration_worktree_commits",
  "collaboration_worktree_units",
  "collaboration_worktree_changesets",
  "collaboration_worktree_unit_seeds",
  "collaboration_worktree_unit_merge_artifacts",
  "collaboration_worktree_deleted_units",
  "collaboration_worktrees",
];

/**
 * POST /api/univer/worktree-delete
 * Body: { file: <path.univer>, worktree: <id> }
 *
 * Permanently removes a worktree record (draft/ready/discarded). Merged
 * worktrees cannot be deleted (they are the merge history).
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { file?: unknown; worktree?: unknown } | null;
    const file = typeof body?.file === "string" ? body.file.trim() : "";
    const worktree = typeof body?.worktree === "string" ? body.worktree.trim() : "";

    if (!file.toLowerCase().endsWith(".univer")) {
      return NextResponse.json({ error: "file must be a .univer file" }, { status: 400 });
    }
    if (!worktree) {
      return NextResponse.json({ error: "worktree is required" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(file, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let db: DatabaseSync;
    try {
      db = openUniverDb(file);
    } catch (error) {
      return NextResponse.json(
        { error: "Could not open the .univer database: " + (error instanceof Error ? error.message : String(error)) },
        { status: 500 },
      );
    }

    try {
      const row = db
        .prepare("SELECT status FROM collaboration_worktrees WHERE worktree_id = ?")
        .get(worktree) as { status: string } | undefined;
      if (!row) {
        return NextResponse.json({ error: "Worktree not found" }, { status: 404 });
      }
      if (row.status === "merged") {
        return NextResponse.json({ error: "已合并的工作区不能删除" }, { status: 400 });
      }

      db.exec("BEGIN");
      try {
        for (const table of WORKTREE_TABLES) {
          db.prepare(`DELETE FROM ${table} WHERE worktree_id = ?`).run(worktree);
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw error;
      }
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }

    removeUserEdits(file, worktree);
    return NextResponse.json({ ok: true, worktree });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
