import { openUniverDb } from "./univer-db";

/**
 * Per-sheet grid dims (maxRow/maxColumn + name) read straight from the
 * .univer SQLite snapshot — replaces `univer inspect workbook` (~8s CLI call)
 * with a milliseconds read.
 *
 * Structure matches the previous inspect-based output:
 *   [{ name, maxRow, maxColumn }]
 *
 * Returns null when the unit/snapshot can't be read (caller falls back).
 * Worktree dims come from the trunk snapshot: sheet rowCount/columnCount
 * changes via execute are rare, and if a worktree's changesets carry a
 * sheet-config mutation we fall back to `univer inspect` (see
 * hasSheetConfigMutation) so the viewer still gets exact dims.
 */
export interface SheetDims {
  name: string;
  maxRow: number;
  maxColumn: number;
}

export function hasSheetConfigMutation(file: string, worktree: string): boolean {
  if (!worktree) return false;
  try {
    const db = openUniverDb(file, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT payload_json FROM collaboration_worktree_changesets WHERE worktree_id = ?")
        .all(worktree) as Array<{ payload_json: string }>;
      for (const r of rows) {
        const cs = JSON.parse(r.payload_json) as { mutations?: Array<{ id?: string }> };
        for (const m of cs.mutations ?? []) {
          if (m.id?.includes("sheet-config") || m.id?.includes("rowCount") || m.id?.includes("colCount")) {
            return true;
          }
        }
      }
    } finally {
      db.close();
    }
  } catch {
    /* treat as no mutation */
  }
  return false;
}

export function readSheetDimsFromDb(file: string, unitId: string): SheetDims[] | null {
  try {
    const db = openUniverDb(file, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT payload_json FROM collaboration_snapshots WHERE unit_id = ? ORDER BY revision DESC LIMIT 1")
        .get(unitId) as { payload_json: string } | undefined;
      if (!row) return null;
      const j = JSON.parse(row.payload_json) as {
        workbook?: {
          sheetOrder?: string[];
          sheets?: Record<string, { name?: string; rowCount?: number; columnCount?: number }>;
        };
      };
      const wb = j.workbook;
      if (!wb?.sheets || !Array.isArray(wb.sheetOrder)) return null;
      const dims = wb.sheetOrder
        .map((id) => wb.sheets?.[id])
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .map((s) => ({
          name: s.name ?? "",
          maxRow: s.rowCount ?? 0,
          maxColumn: s.columnCount ?? 0,
        }));
      return dims.length > 0 ? dims : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
