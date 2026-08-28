import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { basename } from "path";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { compactUniverFile } from "@/lib/univer-compact";
import { runUniver } from "@/lib/univer-cli";
import { bridgeRegistryKey, rememberBridgeTarget, resolveReusedBridge } from "@/lib/univer-office-bridge";
import { reserveUploadPath } from "@/lib/uploads";

/** /api/univer/from-xlsx 接受的源格式（CLI 自动按后缀推断单元类型：xlsx→sheet、docx→doc、pptx→slide…）。 */
const SOURCE_PATTERN = /\.(xlsx|xls|csv|tsv|docx|doc|pptx|ppt)$/i;

/** /api/unifer/from-xlsx 接受的源格式 → 转换后主单元类型（kind 用于前端选择 skill 提示词）。 */
const SOURCE_KIND: Record<string, "sheet" | "doc" | "slide"> = {
  xlsx: "sheet", xls: "sheet", csv: "sheet", tsv: "sheet",
  doc: "doc", docx: "doc", ppt: "slide", pptx: "slide",
};

/**
 * POST /api/univer/from-xlsx
 * Body: { file: <path.xlsx|.docx|.pptx|…> }
 *
 * Converts an office document into a NEW .univer file via `univer import`, so
 * the user can open it in the Univer viewer and let the agent edit it through
 * the sheet-edit (tables) or office-edit (doc/slide) skills — the worktree
 * workflow. Route name is historical: it started as xlsx-only but also takes
 * csv/tsv/doc/docx/ppt/pptx now.
 *
 * The target .univer is ALWAYS stored in the uploads directory
 * (pi-web data dir, default `<project>/pi-web-uploads/`, configurable via
 * lib/storage-config.ts), never next to the source in a project tree.
 * Name: `<basename>-ai-edit[-n].univer` (deduped, never overwrites an existing
 * file — the same-name .univer may already be open in the viewer).
 *
 * Reuse: repeated「AI 编辑」clicks on an unchanged source are deduped via
 * lib/univer-office-bridge.ts (unchanged mtime+size + still-existing target →
 * return it instead of importing yet another copy).
 *
 * Returns:
 *   { file: <path.univer>, kind: sheet|doc|slide, created: true }  — fresh
 *   { file: <path.univer>, kind, reused: true }                    — cached
 *   { error: string }                        — failure
 */
/**
 * In-flight conversion dedup, keyed by the bridge registry key of the SOURCE.
 *
 * The conversion auto-triggers from several entry points (changed-files card,
 * task-area card, the 「AI 编辑」 button); two triggers landing in the same
 * second used to run two imports against the same reserved target path —
 * reserveUploadPath checks existsSync (target not written yet) and the CLI's
 * "already has trunk units" guard only sees MERGED trunk state, so both racing
 * imports each merged their own import-baseline worktree and the .univer ended
 * up with duplicate units (observed 2026-08-27: one file holding two identical
 * 幻灯片 units from a single pptx). Sharing one pipeline makes the second
 * request simply await the first instead of importing again.
 */
const inFlightConversions = new Map<string, Promise<NextResponse>>();

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { file?: unknown } | null;
    const rawFile = typeof body?.file === "string" ? body.file.trim() : "";
    const file = rawFile.replace(/\\/g, "/");

    if (!SOURCE_PATTERN.test(file)) {
      return NextResponse.json({ error: "file must be a .xlsx/.xls/.csv/.tsv/.docx/.doc/.pptx/.ppt file" }, { status: 400 });
    }

    const key = bridgeRegistryKey(file);
    let pipeline = inFlightConversions.get(key);
    if (!pipeline) {
      pipeline = convertOnce(file).finally(() => {
        inFlightConversions.delete(key);
      });
      inFlightConversions.set(key, pipeline);
    }
    return await pipeline;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** One full conversion for a validated source path. */
async function convertOnce(file: string): Promise<NextResponse> {
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(file, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  if (!existsSync(file)) {
    return NextResponse.json({ error: `File not found: ${file}` }, { status: 404 });
  }

  // Same content converted before (and target survives) → reuse it. Office
  // bridges open automatically, so without this every open would pile up a
  // new copy; the xlsx "AI 编辑" button benefits too.
  const ext = (file.match(/\.([a-z0-9]+)$/i)?.[1] ?? "xlsx").toLowerCase();
  const kind = SOURCE_KIND[ext] ?? "sheet";
  const reused = resolveReusedBridge(file);
  if (reused) {
    return NextResponse.json({ file: reused, kind, reused: true });
  }

  // Target lives in the uploads dir with a unique deduped name.
  const sourceBase = basename(file).replace(SOURCE_PATTERN, "");
  const target = reserveUploadPath(`${sourceBase}-ai-edit.univer`).path;

  // `univer import` creates the .univer baseline (trunk) from the xlsx.
  // runUniver retries once on daemon cold-start races (self-healing).
  try {
    await runUniver([
      "import",
      "--file", file,
      target,
      "--formula-calculation", "forced",
      "--json",
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A twin import (second app instance / an earlier crashed run) already
    // populated this target — treat it as the finished conversion instead of
    // failing the user's click with a raw CLI error.
    if (existsSync(target) && /already has trunk units/i.test(message)) {
      rememberBridgeTarget(file, target);
      return NextResponse.json({ file: target, kind, reused: true });
    }
    throw error;
  }

  if (!existsSync(target)) {
    return NextResponse.json({ error: "Failed to create .univer from source (CLI reported success but no file was written)" }, { status: 500 });
  }

  // `univer import` leaves the same cell payload stored 3× (trunk blocks +
  // the internal import-baseline worktree's seed + merge artifact). Drop the
  // dead copies of the merged baseline so a 29MB file becomes ~9.8MB.
  // Best-effort: a locked/unreadable DB keeps the unoptimized file instead
  // of failing the conversion.
  const compacted = compactUniverFile(target);

  rememberBridgeTarget(file, target);

  return NextResponse.json({ file: target, kind, created: true, compacted: compacted !== null });
}
