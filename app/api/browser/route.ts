import { NextRequest, NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getInternalDir } from "@/lib/storage-config";
import { normalizeUserUrl } from "@/lib/browser-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MARKER_PATH = join(getInternalDir(), "pi-web-browser.json");
const MAX_TITLE_LENGTH = 200;

export interface BrowserMarker {
  id: string;
  url: string;
  title: string | null;
  updatedAt: string;
}

interface MarkerFileShape {
  id?: unknown;
  url?: unknown;
  title?: unknown;
  updatedAt?: unknown;
}

function readMarker(): BrowserMarker | null {
  try {
    if (!existsSync(MARKER_PATH)) return null;
    const parsed = JSON.parse(readFileSync(MARKER_PATH, "utf8")) as MarkerFileShape;
    if (
      typeof parsed.id === "string"
      && typeof parsed.url === "string"
      && typeof parsed.updatedAt === "string"
    ) {
      return {
        id: parsed.id,
        url: parsed.url,
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
 * Web-preview marker — the agent-facing half of the right-panel browser.
 *
 * The pi-studio UI polls this route while a session or web tab is active and
 * opens/navigates the panel whenever a new marker appears, so an agent can
 * show a web page (e.g. a freshly started dev server) without the user
 * typing anything:
 *
 *   curl -s -X POST http://localhost:10141/api/browser \
 *     -H 'Content-Type: application/json' \
 *     -d '{"url":"http://localhost:5173","title":"Vite dev server"}'
 *
 * GET    /api/browser          → current marker (nulls when unset)
 * POST   /api/browser {url,title?} → creates a marker, returns it
 * DELETE /api/browser          → clears the marker (called by the UI after apply)
 */
export async function GET() {
  const marker = readMarker();
  return NextResponse.json(marker ?? { id: null, url: null, title: null, updatedAt: null });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { url?: unknown; title?: unknown } | null;
  const url = normalizeUserUrl(typeof body?.url === "string" ? body.url : "");
  if (!url) {
    return NextResponse.json({ error: "Invalid URL — must be a valid http(s) address" }, { status: 400 });
  }
  const rawTitle = typeof body?.title === "string" ? body.title.trim() : "";
  const marker: BrowserMarker = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    title: rawTitle ? rawTitle.slice(0, MAX_TITLE_LENGTH) : null,
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
