import { NextRequest, NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { getInternalDir } from "@/lib/storage-config";

// Marker lives in pi-studio's own data dir (default <project>/pi-web-uploads/.internal),
// NOT in ~/.pi/agent — see lib/storage-config.ts for the configurable location.
const MARKER_PATH = join(getInternalDir(), "pi-web-open-file.json");
const MAX_PATH_LENGTH = 2048;

/**
 * Tracks which file is currently open in the right panel of the pi-studio UI.
 *
 * The browser writes the active file tab here (POST) whenever it changes, so
 * the agent (running on the same machine) can read it back (GET) to know which
 * file the user is looking at — used as the default target when the user asks
 * to edit "the table I have open".
 *
 * GET  /api/open-file            → { filePath, updatedAt } (nulls if unset)
 * POST /api/open-file  { filePath } → same shape, persisted to disk
 */
export async function GET() {
  try {
    if (!existsSync(MARKER_PATH)) {
      return NextResponse.json({ filePath: null, updatedAt: null });
    }
    const parsed = JSON.parse(readFileSync(MARKER_PATH, "utf8"));
    return NextResponse.json({
      filePath: typeof parsed.filePath === "string" ? parsed.filePath : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    });
  } catch {
    return NextResponse.json({ filePath: null, updatedAt: null });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { filePath?: unknown } | null;
    const raw = typeof body?.filePath === "string" ? body.filePath.trim() : "";
    if (raw.length > MAX_PATH_LENGTH) {
      return NextResponse.json({ error: "filePath too long" }, { status: 400 });
    }
    const payload = {
      filePath: raw || null,
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(getInternalDir(), { recursive: true });
    const tmp = MARKER_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, MARKER_PATH);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
