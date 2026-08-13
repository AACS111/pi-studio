import { NextRequest, NextResponse } from "next/server";
import { existsSync, realpathSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";
import { resolveExternalFileTarget } from "@/lib/univer-paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

const MAX_PATH_LENGTH = 2048;

/**
 * Open a file with the OS default application. Used by the generated-files
 * card's "open externally" action.
 *
 * For a .univer file whose original .xlsx exists next to it, the .xlsx is the
 * open target (the user edits the real spreadsheet in Excel/WPS); otherwise
 * the .univer itself is used.
 *
 * POST /api/files/open-external  { filePath } → { ok: true } | 403/404
 *
 * Only paths inside the allowed file roots are accepted. `execFile` with an
 * args array means no shell interpolation — command injection is not possible.
 */
export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { filePath?: unknown } | null;
  const filePath = typeof body?.filePath === "string" ? body.filePath.trim() : "";
  if (!filePath || filePath.length > MAX_PATH_LENGTH) {
    return NextResponse.json({ error: "filePath is required" }, { status: 400 });
  }

  const externalTarget = resolveExternalFileTarget(filePath);
  const existsTarget = existsSync(externalTarget);
  const target = existsTarget ? externalTarget : (externalTarget !== filePath && existsSync(filePath) ? filePath : null);
  if (!target) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(target, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  let realPath: string;
  try {
    realPath = realpathSync(target);
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    if (process.platform === "win32") {
      // cmd /c start "" "path" — the empty title arg is required; execFile
      // quotes args so spaces are safe.
      await execFileAsync("cmd.exe", ["/c", "start", "", realPath], { windowsHide: true });
    } else if (process.platform === "darwin") {
      await execFileAsync("open", [realPath], { windowsHide: true });
    } else {
      await execFileAsync("xdg-open", [realPath], { windowsHide: true });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  return NextResponse.json({ ok: true, filePath: realPath });
}
