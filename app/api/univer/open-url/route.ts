import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { resolveViewerUrl } from "@/lib/univer-open";

/**
 * GET /api/univer/open-url?file=<path.univer>&worktree=<id ?>&unit=<unitId?>
 *
 * Resolves the version-matched official viewer URL served by the univer-cli
 * daemon's Collab Gateway (`univer open --json`). The gateway viewer supports
 * ALL unit kinds (Sheet / Doc / Slide / Base / Board) — pi-studio embeds it in
 * an iframe for the unit types its native XlsxViewer cannot render yet.
 *
 * Returns { ok: true, url }.
 */
export async function GET(request: NextRequest) {
  try {
    const file = request.nextUrl.searchParams.get("file")?.trim() ?? "";
    const worktree = request.nextUrl.searchParams.get("worktree")?.trim() ?? "";
    const unit = request.nextUrl.searchParams.get("unit")?.trim() ?? "";
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
    // unitId is a short opaque token (e.g. "5PekWM") — keep it strict.
    if (unit && !/^[\w-]{1,64}$/.test(unit)) {
      return NextResponse.json({ error: "invalid unit id" }, { status: 400 });
    }

    const url = await resolveViewerUrl({
      file,
      worktree: worktree || undefined,
      unit: unit || undefined,
    });
    return NextResponse.json({ ok: true, url });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
