import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { runUniver } from "@/lib/univer-cli";

/**
 * POST /api/univer/discard
 * Body: { file: <path.univer>, worktree: <id> }
 *
 * Discards a worktree (removes it and its edits) — `univer worktree discard`.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as { file?: unknown; worktree?: unknown } | null;
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

    try {
      await runUniver(["worktree", "discard", file, "--worktree", worktree]);
    } catch (error) {
      return NextResponse.json({ error: "Discard failed: " + (error instanceof Error ? error.message : String(error)) }, { status: 409 });
    }

    return NextResponse.json({ ok: true, worktree });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
