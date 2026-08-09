import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { runUniver } from "@/lib/univer-cli";

/**
 * POST /api/univer/worktree-create
 * Body: { file: <path.univer>, name?: string }
 *
 * Creates a new draft worktree from trunk via `univer worktree add`, so the
 * user always has an "编辑中" scope to edit online even when none exists.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { file?: unknown; name?: unknown } | null;
    const file = typeof body?.file === "string" ? body.file.trim() : "";
    const rawName = typeof body?.name === "string" ? body.name.trim() : "";

    if (!file.toLowerCase().endsWith(".univer")) {
      return NextResponse.json({ error: "file must be a .univer file" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(file, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const name = rawName || `u-${100000 + Math.floor(Math.random() * 900000)}`;
    const args = ["worktree", "add", file, "--name", name];
    let stdout = "";
    try {
      stdout = await runUniver(args);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }

    const m = stdout.match(/created worktree (\S+)/);
    if (!m) {
      return NextResponse.json({ error: "Could not parse created worktree id" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      worktree: { id: m[1], status: "draft", name, headCommit: 0, commits: [] },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
