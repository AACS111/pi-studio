import { createHash } from "crypto";
import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runUniver } from "./univer-cli";
import { readSheetDimsFromDb, hasSheetConfigMutation } from "./univer-dims";
import { resolveUnitIdCached } from "./univer-unit-id";
import { openUniverDb } from "./univer-db";

/**
 * Shared xlsx-export cache for /api/univer/view.
 *
 * The viewer renders a .univer file by exporting the requested scope to xlsx
 * bytes (Univer CLI). Export costs ~11-14s on a 16MB workbook, so results are
 * cached and keyed per scope:
 *  - worktree scope: keyed by headCommit (SQLite read, ms) — a commit to one
 *    worktree only invalidates that worktree's entry;
 *  - trunk scope: keyed by file mtime (trunk only changes on merges).
 * Each entry also carries the per-sheet grid dims (xlsx export loses them).
 *
 * Also exposes warmViewScope() so the write path (edit-commit) can prewarm the
 * cache right after a commit — the next viewer request then serves cached
 * bytes instead of a fresh 23s export.
 */
declare global {
  var __univerExportCache: Map<string, { bytes: Buffer; savedAt: number; rev: string; dims: string | null }> | undefined;
  var __univerExportInflight: Map<string, Promise<Buffer>> | undefined;
  var __univerWarmAbort: AbortController | undefined;
}

export const UNIVER_EXPORT_CACHE_TTL_MS = 30 * 60 * 1000;

export function getExportCache(): Map<string, { bytes: Buffer; savedAt: number; rev: string; dims: string | null }> {
  if (!globalThis.__univerExportCache) globalThis.__univerExportCache = new Map();
  return globalThis.__univerExportCache;
}

function getInflight(): Map<string, Promise<Buffer>> {
  if (!globalThis.__univerExportInflight) globalThis.__univerExportInflight = new Map();
  return globalThis.__univerExportInflight;
}

/** Fast worktree headCommit lookup straight from the .univer SQLite database; null on any read error. */
export function readWorktreeHeadCommit(file: string, worktree: string): string | null {
  try {
    const db = openUniverDb(file, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT head_commit FROM collaboration_worktrees WHERE worktree_id = ?")
        .get(worktree) as { head_commit: number } | undefined;
      return row ? String(row.head_commit) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function viewCacheKey(file: string, worktree: string, rev: string): string {
  return createHash("sha1").update(`${file}|${worktree ? `wt:${worktree}` : `trunk|${rev}`}`).digest("hex");
}

export async function exportScopeToXlsx(file: string, worktree: string, cacheKey: string, signal?: AbortSignal): Promise<Buffer> {
  const tmpXlsx = join(tmpdir(), `univer-view-${cacheKey}.xlsx`);
  const exportArgs = ["export", file, tmpXlsx, "--formula-calculation", "forced"];
  if (worktree) exportArgs.push("--worktree", worktree);
  // One extra retry beyond runUniver's default: the export races the daemon's
  // write lock when the agent is mid-edit (SQLITE_BUSY), and a single 800ms
  // retry is often too short for a multi-second commit on a big workbook.
  await runUniver(exportArgs, { signal, retries: 2 });
  try {
    return readFileSync(tmpXlsx);
  } finally {
    try { rmSync(tmpXlsx, { force: true }); } catch { /* ignore */ }
  }
}

/** Per-sheet grid dims for the viewer header. SQLite-first, inspect fallback. */
export async function readSheetDims(file: string, worktree: string): Promise<string | null> {
  try {
    const unitId = await resolveUnitIdCached(file);
    if (!unitId) return null;
    // Worktrees that changed sheet config (rowCount/colCount) fall back to the
    // authoritative `univer inspect`; everything else reads dims from SQLite.
    if (!worktree || !hasSheetConfigMutation(file, worktree)) {
      const dims = readSheetDimsFromDb(file, unitId);
      if (dims && dims.length > 0) return JSON.stringify(dims);
    }
    const args = ["inspect", "workbook", file, "--unit", unitId, "--json"];
    if (worktree) args.push("--worktree", worktree);
    const out = await runUniver(args);
    const parsed = JSON.parse(out) as {
      sheets?: Array<{ name?: string; maxRow?: number; maxColumn?: number }>;
    };
    const dims = (parsed.sheets ?? []).map((s) => ({
      name: s.name ?? "",
      maxRow: s.maxRow ?? 0,
      maxColumn: s.maxColumn ?? 0,
    }));
    return dims.length > 0 ? JSON.stringify(dims) : null;
  } catch {
    return null;
  }
}

/** Runs `run` once per cacheKey; concurrent requests share the same promise. */
export function exportOnce(cacheKey: string, run: () => Promise<Buffer>): Promise<Buffer> {
  const inflight = getInflight();
  let p = inflight.get(cacheKey);
  if (!p) {
    p = run()
      .then((bytes) => {
        inflight.delete(cacheKey);
        return bytes;
      })
      .catch((error) => {
        inflight.delete(cacheKey);
        throw error;
      });
    inflight.set(cacheKey, p);
  }
  return p;
}

/**
 * Cancel any in-flight background view prewarm (called at the start of a new
 * write) so the daemon isn't queued behind a stale export when the user
 * immediately edits again. Never throws.
 */
export function cancelWarmViewScope(): void {
  try {
    globalThis.__univerWarmAbort?.abort();
  } catch {
    /* ignore */
  }
  globalThis.__univerWarmAbort = undefined;
}

/**
 * Prewarm the view export cache for a scope (fire-and-forget). Called by the
 * write path after a commit so the next viewer request is served from cache.
 * The running export is abortable (cancelWarmViewScope) so a new edit isn't
 * queued behind it. Never throws.
 */
export async function warmViewScope(file: string, worktree: string): Promise<void> {
  try {
    const rev = worktree ? (readWorktreeHeadCommit(file, worktree) ?? "") : "";
    const cacheKey = viewCacheKey(file, worktree, rev);
    const cache = getExportCache();
    const existing = cache.get(cacheKey);
    if (existing && Date.now() - existing.savedAt < UNIVER_EXPORT_CACHE_TTL_MS) return;
    const controller = new AbortController();
    globalThis.__univerWarmAbort = controller;
    try {
      const bytes = await exportScopeToXlsx(file, worktree, cacheKey, controller.signal);
      const dims = await readSheetDims(file, worktree);
      cache.set(cacheKey, { bytes, savedAt: Date.now(), rev, dims });
    } finally {
      if (globalThis.__univerWarmAbort === controller) globalThis.__univerWarmAbort = undefined;
    }
  } catch {
    /* best-effort — the viewer will export on demand */
  }
}
