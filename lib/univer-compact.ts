import { openUniverDb } from "./univer-db";
import type { DatabaseSync } from "node:sqlite";

/**
 * Best-effort compaction of a freshly imported .univer file.
 *
 * Why: `univer import` materializes the same cell payload three times —
 * (1) the trunk `collaboration_sheet_blocks`, (2) the internal
 * `import-baseline` worktree's `collaboration_worktree_unit_seeds` snapshot,
 * and (3) its `collaboration_worktree_unit_merge_artifacts` snapshot. On a
 * typical 834KB xlsx that triples the on-disk size (29MB → 9.8MB measured).
 *
 * Safety: only rows belonging to ALREADY-merged worktrees are removed, and
 * merged worktrees are immutable merge history — their seed/artifact copies
 * are byte-for-byte duplicates of content that lives on in the trunk blocks
 * (verified: `univer worktree list`, `univer export`, and the full
 * add → execute → ready → merge round-trip all keep working after cleanup).
 * Active draft/ready worktrees are never touched, so their seed/artifact rows
 * (load-bearing for ready/merge/rollback) survive intact.
 *
 * Best-effort: if the DB is locked by the daemon or unreadable, returns null
 * and the caller keeps the unoptimized file — conversion must not fail over
 * an optimization step.
 *
 * @returns { removedSeeds, removedArtifacts } row counts, or null when the DB
 *          could not be opened/compacted.
 */
export function compactUniverFile(file: string): { removedSeeds: number; removedArtifacts: number } | null {
  let db: DatabaseSync;
  try {
    db = openUniverDb(file);
  } catch {
    return null;
  }

  try {
    const delSeeds = db
      .prepare(
        "DELETE FROM collaboration_worktree_unit_seeds " +
          "WHERE worktree_id IN (SELECT worktree_id FROM collaboration_worktrees WHERE status = 'merged')",
      )
      .run();
    const delArtifacts = db
      .prepare(
        "DELETE FROM collaboration_worktree_unit_merge_artifacts " +
          "WHERE worktree_id IN (SELECT worktree_id FROM collaboration_worktrees WHERE status = 'merged')",
      )
      .run();

    if (delSeeds.changes > 0 || delArtifacts.changes > 0) {
      // Rebuild the file so the freed pages actually shrink the on-disk size.
      db.exec("VACUUM");
    }

    return { removedSeeds: Number(delSeeds.changes), removedArtifacts: Number(delArtifacts.changes) };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
