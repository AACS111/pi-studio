import { NextRequest, NextResponse } from "next/server";
import { writeFileSync } from "fs";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { isWindowsAbsolutePath } from "@/lib/file-access";

const MAX_SAVE_BYTES = 25 * 1024 * 1024;

/**
 * POST /api/files/save
 * Body: { filePath: string, base64: string }
 *
 * Writes a (potentially binary) file back to disk — used by the spreadsheet
 * viewer to save an edited .xlsx. The target must exist and resolve inside an
 * allowed root, same rules as /api/files reads.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as { filePath?: unknown; base64?: unknown } | null;
    const filePath = typeof body?.filePath === "string" ? body.filePath.trim() : "";
    const base64 = typeof body?.base64 === "string" ? body.base64 : "";

    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return NextResponse.json({ error: "filePath must be an absolute path" }, { status: 400 });
    }
    if (!base64) {
      return NextResponse.json({ error: "base64 content is required" }, { status: 400 });
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      return NextResponse.json({ error: "Invalid base64 content" }, { status: 400 });
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SAVE_BYTES) {
      return NextResponse.json({ error: `Content must be between 1 byte and ${MAX_SAVE_BYTES} bytes` }, { status: 413 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    writeFileSync(filePath, bytes);
    return NextResponse.json({ ok: true, size: bytes.byteLength });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
