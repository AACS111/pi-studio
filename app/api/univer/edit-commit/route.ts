import { NextRequest, NextResponse } from "next/server";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { recordUserEdit } from "@/lib/univer-user-edits";
import { resolveUnitIdCached } from "@/lib/univer-unit-id";
import { runUniver } from "@/lib/univer-cli";
import { cancelWarmViewScope, warmViewScope } from "@/lib/univer-view-cache";


interface CellChange {
  r: number;
  c: number;
  clear?: boolean;
  cell?: { v?: unknown; t?: number };
}

function serializeValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  return JSON.stringify(String(v));
}

function buildScript(changes: CellChange[]): string {
  const lines: string[] = [];
  changes.forEach((ch, i) => {
    if (ch.clear) {
      lines.push(
        `const __c${i}=workbook.getActiveSheet().getRange(${ch.r},${ch.c},1,1);` +
          `__c${i}.setValue({v:null,f:null,p:null,si:null,custom:null});`,
      );
    } else {
      const cell = ch.cell ?? { v: null, t: 1 };
      const v = serializeValue(cell.v);
      const t = typeof cell.t === "number" ? cell.t : typeof cell.v === "number" ? 2 : typeof cell.v === "boolean" ? 3 : 1;
      lines.push(`workbook.getActiveSheet().getRange(${ch.r},${ch.c},1,1).setValue({v:${v},t:${t}});`);
    }
  });
  lines.push(`return ${changes.length};`);
  return lines.join("\n");
}

/**
 * POST /api/univer/edit-commit
 * Body: { file: <path.univer>, worktree: <id>, changes: CellChange[] }
 *
 * Commits online (in-viewer) cell edits to a worktree via `univer execute`
 * (generated per-cell setValue script), then records the new commit seq as a
 * user edit so the UI can label it "u{seq}" instead of "r{seq}".
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      file?: unknown;
      worktree?: unknown;
      changes?: unknown;
    } | null;
    const file = typeof body?.file === "string" ? body.file.trim() : "";
    const worktree = typeof body?.worktree === "string" ? body.worktree.trim() : "";
    const changes = Array.isArray(body?.changes)
      ? (body.changes as CellChange[]).filter((ch) => ch && typeof ch.r === "number" && typeof ch.c === "number")
      : [];
    const trunkMode = worktree === "";

    // Edits are worktree-only (user rule 2026-08-08): never write into trunk
    // directly. The viewer auto-creates a draft worktree on first edit, so by
    // the time a request arrives there is always a worktree id.
    if (trunkMode) {
      return NextResponse.json({ error: "编辑必须发生在工作区：请先创建或选择一个工作区" }, { status: 400 });
    }

    // A new edit supersedes any stale background view prewarm — cancel it so
    // the daemon isn't queued behind the previous commit's export.
    cancelWarmViewScope();

    if (!file.toLowerCase().endsWith(".univer")) {
      return NextResponse.json({ error: "file must be a .univer file" }, { status: 400 });
    }
    if (changes.length === 0) {
      return NextResponse.json({ error: "no changes to commit" }, { status: 400 });
    }
    if (changes.length > 50_000) {
      return NextResponse.json({ error: "too many changes" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(file, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const unitId = await resolveUnitIdCached(file);
    if (!unitId) {
      return NextResponse.json({ error: "Could not resolve a sheet unit in the .univer file" }, { status: 400 });
    }

    // Trunk edits are rejected above (worktree-only editing); targetWorktree
    // is always the caller-provided worktree.
    const targetWorktree = worktree;

    // --script avoids Windows command-line length limits for big diffs.
    // --json makes the committed seq parseable from stdout, skipping the
    // separate `worktree log` round-trip in the happy path.
    const dir = mkdtempSync(join(tmpdir(), "univer-edit-"));
    const scriptPath = join(dir, "edit.mjs");
    writeFileSync(scriptPath, buildScript(changes), "utf8");
    let stdout = "";
    try {
      stdout = await runUniver(["execute", file, "--worktree", worktree, "--unit", unitId, "--script", scriptPath, "--json"]);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // The new head seq comes straight from execute --json; fall back to the
    // commit marker in text output, then to `worktree log` for older CLIs.
    let seq = 0;
    try {
      const parsed = JSON.parse(stdout) as { commitSeq?: unknown };
      if (typeof parsed.commitSeq === "number") seq = parsed.commitSeq;
    } catch {
      /* not JSON — legacy text output */
    }
    if (!seq) {
      const m = stdout.match(/committed #(\d+)/);
      if (m) seq = Number(m[1]);
    }
    if (!seq) {
      try {
        const logOut = await runUniver(["worktree", "log", file, "--worktree", targetWorktree]);
        const lines = logOut.trim().split("\n").filter(Boolean);
        const last = lines[lines.length - 1]?.match(/^#(\d+)/);
        if (last) seq = Number(last[1]);
      } catch { /* keep 0 */ }
    }

    recordUserEdit(file, targetWorktree, seq);

    // Prewarm the viewer export cache (fire-and-forget) so the next view
    // request serves cached bytes instead of a fresh ~23s export. Keyed on the
    // new headCommit; the next edit cancels this run (cancelWarmViewScope).
    void warmViewScope(file, targetWorktree);

    return NextResponse.json({ ok: true, seq, committed: changes.length, worktree: targetWorktree, mergedToTrunk: false, trunkMtime: 0 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
