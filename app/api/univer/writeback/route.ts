import { NextRequest, NextResponse } from "next/server";
import { closeSync, existsSync, openSync } from "fs";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { runUniver } from "@/lib/univer-cli";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFileLocked(file: string): boolean {
  try {
    const fd = openSync(file, "r+");
    closeSync(fd);
    return false;
  } catch {
    return true;
  }
}

async function resolveUnitId(file: string): Promise<string> {
  const statusOut = await runUniver(["status", file, "--json"]);
  const parsed = JSON.parse(statusOut) as { units?: Array<{ unitId: string }> };
  return parsed.units?.[0]?.unitId ?? "";
}

/**
 * POST /api/univer/writeback
 * Body: { file: <path.univer>, worktree?: <id> }
 *
 * Writes the current scope (trunk by default, or a worktree) back to the
 * original .xlsx file — the same basename with a .xlsx extension next to the
 * .univer file (e.g. hello.univer → hello.xlsx). Overwrites the original.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { file?: unknown; worktree?: unknown } | null;
    const file = typeof body?.file === "string" ? body.file.trim() : "";
    const worktree = typeof body?.worktree === "string" ? body.worktree.trim() : "";

    if (!file.toLowerCase().endsWith(".univer")) {
      return NextResponse.json({ error: "file must be a .univer file" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(file, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Original = same basename with .xlsx extension, next to the .univer file.
    const target = file.replace(/\.univer$/i, ".xlsx");
    if (target === file || !isFilePathAllowed(target, allowedRoots)) {
      return NextResponse.json({ error: "Original file is outside allowed roots" }, { status: 403 });
    }
    if (!existsSync(target)) {
      return NextResponse.json({ error: `Original file not found: ${target}` }, { status: 404 });
    }
    if (isFileLocked(target)) {
      return NextResponse.json(
        { error: "目标 .xlsx 文件正被其他程序占用（可能正在 WPS/Excel 中打开），请关闭该文件后重试。" },
        { status: 409 },
      );
    }

    const unitId = await resolveUnitId(file);
    if (!unitId) {
      return NextResponse.json({ error: "Could not resolve a sheet unit in the .univer file" }, { status: 400 });
    }

    const exportArgs = ["export", file, target, "--unit", unitId, "--formula-calculation", "forced"];
    if (worktree) exportArgs.push("--worktree", worktree);

    // Retry a few times: Windows can briefly hold the file after the pre-check
    // (indexers, antivirus). If it stays locked, fail with a friendly message.
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await runUniver(exportArgs);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await sleep(500 * (attempt + 1));
      }
    }
    if (lastError) {
      const raw = lastError instanceof Error ? lastError.message : String(lastError);
      const locked =
        raw.includes("being used by another process") || raw.includes("EBUSY") || raw.includes("resource busy");
      return NextResponse.json(
        {
          error: locked
            ? "目标 .xlsx 文件正被其他程序占用（可能正在 WPS/Excel 中打开），请关闭该文件后重试。"
            : raw,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, target, worktree: worktree || null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
