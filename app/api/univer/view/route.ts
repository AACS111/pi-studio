import { NextRequest, NextResponse } from "next/server";
import { statSync } from "fs";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import {
  UNIVER_EXPORT_CACHE_TTL_MS,
  exportOnce,
  exportScopeToXlsx,
  getExportCache,
  readSheetDims,
  readWorktreeHeadCommit,
  viewCacheKey,
} from "@/lib/univer-view-cache";

/**
 * GET /api/univer/view?file=<.univer path>[&worktree=<id>]
 *
 * Renders a .univer file (Univer CLI format) for the in-browser Univer viewer:
 * the CLI exports the requested scope to xlsx bytes, which the front-end
 * spreadsheet viewer already knows how to render. Agent edits flow through
 * `univer execute`, so the viewer refreshes by re-requesting this endpoint.
 *
 * Results are cached per scope (worktree=headCommit, trunk=mtime); the write
 * path prewarms the cache after commits (see lib/univer-view-cache.ts), so a
 * user editing then switching to the viewer gets cached bytes (~2s) instead of
 * a fresh export (~23s).
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

    const cache = getExportCache();

    if (worktree) {
      // Worktree scope: validate against the current headCommit (fast SQLite
      // read) instead of file mtime, so a commit to one worktree doesn't
      // invalidate every other scope's cache.
      const currentRev = readWorktreeHeadCommit(file, worktree);
      const cacheKey = viewCacheKey(file, worktree, currentRev ?? "");
      const cached = cache.get(cacheKey);
      if (
        currentRev &&
        cached &&
        cached.rev === currentRev &&
        Date.now() - cached.savedAt < UNIVER_EXPORT_CACHE_TTL_MS
      ) {
        // A first attempt may have raced the daemon and cached dims:null —
        // retry once so the viewer still gets the grid size.
        if (cached.dims == null) {
          const dims = await readSheetDims(file, worktree);
          if (dims) {
            cached.dims = dims;
            return serve(cached.bytes, dims);
          }
        }
        return serve(cached.bytes, cached.dims);
      }
      const bytes = await exportOnce(cacheKey, () => exportScopeToXlsx(file, worktree, cacheKey));
      const dims = await readSheetDims(file, worktree);
      cache.set(cacheKey, { bytes, savedAt: Date.now(), rev: currentRev ?? "", dims });
      return serve(bytes, dims);
    }

    // Trunk scope: mtime-keyed (trunk changes only on merges).
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    const cacheKey = viewCacheKey(file, "", String(mtimeMs));
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < UNIVER_EXPORT_CACHE_TTL_MS) {
      return serve(cached.bytes, cached.dims);
    }
    const bytes = await exportOnce(cacheKey, () => exportScopeToXlsx(file, "", cacheKey));
    const dims = await readSheetDims(file, "");
    cache.set(cacheKey, { bytes, savedAt: Date.now(), rev: "", dims });
    return serve(bytes, dims);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function serve(bytes: Buffer, dims: string | null): NextResponse {
  const res = new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Cache-Control": "no-store",
    },
  });
  if (dims) res.headers.set("X-Univer-Sheet-Dims", encodeURIComponent(dims));
  return res;
}

// recompile-marker-v3
