import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { getInternalDir } from "./storage-config";

/**
 * Tracks which worktree commits came from online (in-viewer) user edits, so the
 * UI can label them distinctly ("u" prefix) from agent/CLI commits ("r").
 *
 * Sidecar file: <pi-web data dir>/.internal/pi-web-univer-user-edits.json
 * (default <project>/pi-web-uploads/.internal — configurable via lib/storage-config.ts)
 * Shape: { "<absoluteFile>|<worktreeId>": number[] }  // commit seqs
 */
const SIDECAR_PATH = join(getInternalDir(), "pi-web-univer-user-edits.json");

type UserEditMap = Record<string, number[]>;

function readSidecar(): UserEditMap {
  try {
    if (!existsSync(SIDECAR_PATH)) return {};
    const parsed = JSON.parse(readFileSync(SIDECAR_PATH, "utf8")) as Record<string, unknown>;
    const out: UserEditMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is number => typeof x === "number");
    }
    return out;
  } catch {
    return {};
  }
}

function writeSidecar(map: UserEditMap): void {
  try {
    mkdirSync(getInternalDir(), { recursive: true });
    const tmp = SIDECAR_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
    renameSync(tmp, SIDECAR_PATH);
  } catch { /* sidecar is best-effort bookkeeping */ }
}

export function getWorktreeUserSeqs(file: string, worktree: string): number[] {
  return readSidecar()[`${file}|${worktree}`] ?? [];
}

/** Record a commit seq as an online user edit; returns the updated seq list. */
export function recordUserEdit(file: string, worktree: string, seq: number): number[] {
  const map = readSidecar();
  const key = `${file}|${worktree}`;
  const list = map[key] ?? [];
  if (!list.includes(seq)) list.push(seq);
  map[key] = list;
  writeSidecar(map);
  return list;
}

/** Attach userSeqs to worktrees (mutates and returns them). */
export function attachUserSeqs(file: string, worktrees: Array<{ id: string }>): void {
  const map = readSidecar();
  for (const wt of worktrees) {
    const seqs = map[`${file}|${wt.id}`] ?? [];
    if (seqs.length > 0) (wt as Record<string, unknown>).userSeqs = seqs;
  }
}

/** Drop the user-edit records for a deleted worktree. */
export function removeUserEdits(file: string, worktree: string): void {
  const map = readSidecar();
  const key = `${file}|${worktree}`;
  if (!(key in map)) return;
  delete map[key];
  writeSidecar(map);
}
