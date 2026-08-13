import { NextRequest, NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getInternalDir } from "@/lib/storage-config";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MARKER_PATH = join(getInternalDir(), "pi-web-open-request.json");
const MAX_PATH_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;

export interface OpenFileRequest {
  id: string;
  filePath: string;
  title: string | null;
  updatedAt: string;
}

interface MarkerFileShape {
  id?: unknown;
  filePath?: unknown;
  title?: unknown;
  updatedAt?: unknown;
}

function readMarker(): OpenFileRequest | null {
  try {
    if (!existsSync(MARKER_PATH)) return null;
    const parsed = JSON.parse(readFileSync(MARKER_PATH, "utf8")) as MarkerFileShape;
    if (
      typeof parsed.id === "string"
      && typeof parsed.filePath === "string"
      && typeof parsed.updatedAt === "string"
    ) {
      return {
        id: parsed.id,
        filePath: parsed.filePath,
        title: typeof parsed.title === "string" ? parsed.title : null,
        updatedAt: parsed.updatedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Agent-facing "open this file in the right panel" marker — the file analogue
 * of /api/browser. The pi-studio UI polls this route and opens the file tab
 * whenever a new marker appears, so an agent that just generated a spreadsheet
 * can push it to the panel without the user clicking anything:
 *
 *   curl -s -X POST http://localhost:10141/api/open-file-request \
 *     -H 'Content-Type: application/json' \
 *     -d '{"filePath":"C:/proj/报表.univer","title":"销售报表"}'
 *
 * GET    /api/open-file-request          → current marker (null when unset)
 * POST   /api/open-file-request {filePath,title?} → creates a marker
 * DELETE /api/open-file-request          → clears the marker (UI calls after apply)
 *
 * The path must exist and sit inside the allowed file roots — the server never
 * lets an agent force-open an arbitrary location.
 */
export async function GET() {
  const marker = readMarker();
  return NextResponse.json(marker ?? { id: null, filePath: null, title: null, updatedAt: null });
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { filePath?: unknown; title?: unknown } | null;
  const raw = typeof body?.filePath === "string" ? body.filePath.trim() : "";
  if (!raw || raw.length > MAX_PATH_LENGTH) {
    return NextResponse.json({ error: "filePath is required" }, { status: 400 });
  }
  if (!existsSync(raw)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(raw, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const marker: OpenFileRequest = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filePath: raw,
    title: typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, MAX_TITLE_LENGTH) : null,
    updatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(getInternalDir(), { recursive: true });
    const tmp = MARKER_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(marker, null, 2), "utf8");
    renameSync(tmp, MARKER_PATH);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  return NextResponse.json(marker);
}

export async function DELETE() {
  try {
    rmSync(MARKER_PATH, { force: true });
  } catch {
    /* already gone */
  }
  return NextResponse.json({ ok: true });
}
