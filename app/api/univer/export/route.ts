import { NextRequest, NextResponse } from "next/server";
import { readFileSync, rmSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { runUniver } from "@/lib/univer-cli";

async function resolveUnitId(file: string): Promise<string> {
  const statusOut = await runUniver(["status", file, "--json"]);
  const parsed = JSON.parse(statusOut) as { units?: Array<{ unitId: string }> };
  return parsed.units?.[0]?.unitId ?? "";
}

async function resolveFirstSheetName(file: string, unitId: string): Promise<string> {
  const out = await runUniver(["inspect", "workbook", file, "--unit", unitId, "--json"]);
  const parsed = JSON.parse(out) as { sheets?: Array<{ name: string }> };
  return parsed.sheets?.[0]?.name ?? "";
}

/**
 * GET /api/univer/export?file=<.univer path>[&worktree=<id>][&format=xlsx|csv]
 *
 * Exports the requested scope (trunk by default, or a worktree) of a .univer
 * file to xlsx or csv bytes for download. CSV export needs a sheet name, which
 * is resolved from `univer inspect workbook`.
 */
export async function GET(request: NextRequest) {
  try {
    const file = request.nextUrl.searchParams.get("file")?.trim() ?? "";
    const worktree = request.nextUrl.searchParams.get("worktree")?.trim() ?? "";
    const format = (request.nextUrl.searchParams.get("format")?.trim() || "xlsx").toLowerCase();

    if (!file.toLowerCase().endsWith(".univer")) {
      return NextResponse.json({ error: "file must be a .univer file" }, { status: 400 });
    }
    if (format !== "xlsx" && format !== "csv") {
      return NextResponse.json({ error: "format must be xlsx or csv" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(file, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const unitId = await resolveUnitId(file);
    if (!unitId) {
      return NextResponse.json({ error: "Could not resolve a sheet unit in the .univer file" }, { status: 400 });
    }

    const ext = format === "csv" ? "csv" : "xlsx";
    const tmpOut = join(tmpdir(), `univer-export-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    const exportArgs = ["export", file, tmpOut, "--unit", unitId, "--formula-calculation", "forced"];
    if (worktree) exportArgs.push("--worktree", worktree);
    if (format === "csv") {
      const sheetName = await resolveFirstSheetName(file, unitId);
      if (!sheetName) {
        return NextResponse.json({ error: "Could not resolve a sheet name for CSV export" }, { status: 400 });
      }
      exportArgs.push("--sheet", sheetName);
    }

    try {
      await runUniver(exportArgs);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(tmpOut);
    } catch {
      return NextResponse.json({ error: "Export produced no output" }, { status: 500 });
    } finally {
      try { rmSync(tmpOut, { force: true }); } catch { /* ignore */ }
    }

    const base = basename(file).replace(/\.univer$/i, "");
    const downloadName = `${base}.${ext}`;
    const contentType = format === "csv"
      ? "text/csv; charset=utf-8"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
