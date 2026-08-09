import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { basename } from "path";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { compactUniverFile } from "@/lib/univer-compact";
import { runUniver } from "@/lib/univer-cli";
import { reserveUploadPath } from "@/lib/uploads";

/**
 * POST /api/univer/from-xlsx
 * Body: { file: <path.xlsx> }
 *
 * Converts a plain .xlsx into a NEW .univer file via `univer import`, so the
 * user can open it in the Univer viewer and let the agent edit it through the
 * sheet-edit skill (worktree workflow).
 *
 * The target .univer is ALWAYS stored in the uploads directory
 * (pi-web data dir, default `<project>/pi-web-uploads/`, configurable via
 * lib/storage-config.ts), never next to the source xlsx in a project
 * tree. Name: `<basename>-ai-edit[-n].univer` (deduped, never overwrites an
 * existing file — the same-name .univer may already be open in the viewer).
 *
 * Returns:
 *   { file: <path.univer>, created: true }  — fresh conversion
 *   { error: string }                        — failure
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { file?: unknown } | null;
    const rawFile = typeof body?.file === "string" ? body.file.trim() : "";
    const file = rawFile.replace(/\\/g, "/");

    if (!/\.(xlsx|xls)$/i.test(file)) {
      return NextResponse.json({ error: "file must be a .xlsx/.xls file" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(file, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (!existsSync(file)) {
      return NextResponse.json({ error: `File not found: ${file}` }, { status: 404 });
    }

    // Target lives in the uploads dir with a unique deduped name.
    const sourceBase = basename(file).replace(/\.(xlsx|xls)$/i, "");
    const target = reserveUploadPath(`${sourceBase}-ai-edit.univer`).path;

    // `univer import` creates the .univer baseline (trunk) from the xlsx.
    // runUniver retries once on daemon cold-start races (self-healing).
    await runUniver([
      "import",
      "--file", file,
      target,
      "--formula-calculation", "forced",
      "--json",
    ]);

    if (!existsSync(target)) {
      return NextResponse.json({ error: "Failed to create .univer from xlsx (CLI reported success but no file was written)" }, { status: 500 });
    }

    // `univer import` leaves the same cell payload stored 3× (trunk blocks +
    // the internal import-baseline worktree's seed + merge artifact). Drop the
    // dead copies of the merged baseline so a 29MB file becomes ~9.8MB.
    // Best-effort: a locked/unreadable DB keeps the unoptimized file instead
    // of failing the conversion.
    const compacted = compactUniverFile(target);

    return NextResponse.json({ file: target, created: true, compacted: compacted !== null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
