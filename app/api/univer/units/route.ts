import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { listUniverUnits } from "@/lib/univer-open";

/**
 * GET /api/univer/units?file=<path.univer>&worktree=<id?>
 *
 * Lists the top-level units (Sheet / Doc / Slide / Base / Board) of a
 * `.univer` file. Scope follows the optional `worktree` param: omit it for
 * trunk, pass a worktree id to list that worktree's units.
 *
 * Returns { ok: true, units: UniverUnitInfo[] } so the viewer can offer a
 * unit-type switcher (native XlsxViewer for sheets, embedded official viewer
 * for doc/slide/base/board).
 */
export async function GET(request: NextRequest) {
  try {
    const file = request.nextUrl.searchParams.get("file")?.trim() ?? "";
    const worktree = request.nextUrl.searchParams.get("worktree")?.trim() ?? "";
    if (!file.toLowerCase().endsWith(".univer")) {
      return NextResponse.json({ error: "file must be a .univer file" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(file, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (worktree && !/^[\w-]+$/.test(worktree)) {
      return NextResponse.json({ error: "invalid worktree id" }, { status: 400 });
    }

    const units = await listUniverUnits(file, worktree || undefined);
    return NextResponse.json({ ok: true, units });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
