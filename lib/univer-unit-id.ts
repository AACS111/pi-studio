import { statSync } from "fs";
import { runUniver } from "./univer-cli";

/**
 * Cached unit-id resolution for .univer files.
 *
 * Unit ids are per-FILE, not per-path: when a .univer file is recreated at the
 * same path (e.g. `univer import` regenerates it), the new file gets a
 * brand-new unitId. A path-keyed cache therefore goes stale, so entries are
 * keyed by path + mtime — recreation always re-resolves.
 *
 * Used by the write path (edit-commit) and the read path (view) so neither
 * pays a `univer status` CLI call per request.
 */
declare global {
  var __piUniverUnitIds: Map<string, { unitId: string; mtimeMs: number }> | undefined;
}

export async function resolveUnitIdCached(file: string): Promise<string> {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return "";
  }
  const cache = (globalThis.__piUniverUnitIds ??= new Map());
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.unitId;
  const out = await runUniver(["status", file, "--json"]);
  let id = "";
  try {
    const parsed = JSON.parse(out) as { units?: Array<{ unitId?: string }> };
    id = parsed.units?.[0]?.unitId ?? "";
  } catch {
    /* keep empty */
  }
  if (id) cache.set(file, { unitId: id, mtimeMs });
  return id;
}
