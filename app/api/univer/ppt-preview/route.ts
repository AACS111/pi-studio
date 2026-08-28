import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { existsSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { compactUniverFile } from "@/lib/univer-compact";
import { runUniver } from "@/lib/univer-cli";
import { resolveViewerUrl } from "@/lib/univer-open";
import { getInternalDir } from "@/lib/storage-config";

/**
 * POST /api/univer/ppt-preview
 * Body: { file: <path.ppt|.pptx> }
 *
 * Read-only preview for PowerPoint documents. pi-studio has no native pptx
 * renderer, so the file is imported into a HIDDEN cache copy under
 * `<dataDir>/.internal/univer-view-cache/` and served through the univer-cli
 * daemon's Collab Gateway viewer in an iframe — change tracking uses the
 * gateway's own sidebar (user decision 2026-08-27). Editing goes through
 * POST /api/univer/from-xlsx only when the user explicitly hits 「AI 编辑」.
 *
 * Why hidden: dot-prefixed internal entries are filtered out of every upload /
 * file listing, so a plain "open the deck" never spawns a visible duplicate
 * `-ai-edit.univer` next to the source (user feedback 2026-08-27). Editing
 * goes through POST /api/univer/from-xlsx only when the user explicitly hits
 * 「AI 编辑」 — same two-step flow as spreadsheets.
 *
 * Cache key = sha1(abs path)|mtimeMs|size: re-imports automatically when the
 * source changes, instant otherwise. Entries older than PREVIEW_TTL_DAYS are
 * pruned opportunistically on each request.
 *
 * Returns:
 *   { file: <cacheTarget>, url: <gateway viewer URL> }
 *   { error: string }
 */

const CACHE_DIR_NAME = "univer-view-cache";
const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Opportunistic cleanup: drop cache copies not touched within the TTL. */
function pruneStaleEntries(cacheDir: string): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(cacheDir)) {
      if (!name.endsWith(".univer")) continue;
      const full = join(cacheDir, name);
      try {
        if (now - statSync(full).mtimeMs > PREVIEW_TTL_MS) {
          rmSync(full, { force: true });
        }
      } catch {
        /* single entry unreadable/busy — skip it */
      }
    }
  } catch {
    /* cache dir missing/unreadable — nothing to prune */
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { file?: unknown } | null;
    const rawFile = typeof body?.file === "string" ? body.file.trim() : "";
    const file = rawFile.replace(/\\/g, "/");

    if (!/\.(ppt|pptx)$/i.test(file)) {
      return NextResponse.json({ error: "file must be a .ppt/.pptx file" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(file, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (!existsSync(file)) {
      return NextResponse.json({ error: `File not found: ${file}` }, { status: 404 });
    }

    const st = statSync(file);
    const key = createHash("sha1")
      .update(`${process.platform === "win32" ? file.toLowerCase() : file}|${st.mtimeMs}|${st.size}`)
      .digest("hex")
      .slice(0, 24);
    const cacheDir = join(getInternalDir(), CACHE_DIR_NAME);
    const target = join(cacheDir, `${key}.univer`).replace(/\\/g, "/");

    if (!existsSync(target)) {
      // Ensure the cache dir exists just-in-time (race-safe enough: recursive
      // mkdir is idempotent).
      try { statSync(cacheDir); } catch {
        const { mkdirSync } = await import("fs");
        mkdirSync(cacheDir, { recursive: true });
      }
      await runUniver([
        "import",
        "--file", file,
        target,
        "--json",
      ]);
      if (!existsSync(target)) {
        return NextResponse.json({ error: "Failed to build preview (CLI reported success but no file was written)" }, { status: 500 });
      }
      // Best-effort size trim; failure keeps the unoptimized copy.
      compactUniverFile(target);
    } else {
      pruneStaleEntries(cacheDir);
    }

    // The cached file holds exactly one slide unit — let the gateway pick it.
    const url = await resolveViewerUrl({ file: target });
    return NextResponse.json({ file: target, url });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
