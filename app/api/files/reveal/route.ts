import { NextRequest, NextResponse } from "next/server";
import { existsSync, realpathSync } from "fs";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";
import { resolveExternalFileTarget } from "@/lib/univer-paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

const MAX_PATH_LENGTH = 2048;

/**
 * Open the containing folder of a file in the OS file manager, with the file
 * selected (Explorer `/select,`). Used by the generated-files card.
 *
 * For a .univer file whose original .xlsx exists next to it, the .xlsx is the
 * reveal target (the user works with the real spreadsheet in Explorer);
 * otherwise the .univer itself is used.
 *
 * POST /api/files/reveal  { filePath } → { ok: true } | 403/404
 *
 * Only paths inside the allowed file roots (same allow-list as /api/files)
 * are accepted — the server never reveals arbitrary locations.
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
  // Resolve symlinks before revealing so a link inside an allowed root
  // cannot redirect Explorer to an arbitrary location.
  let realPath: string;
  try {
    realPath = realpathSync(target);
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    if (process.platform === "win32") {
      // explorer.exe 是 GUI 程序：成功打开后也会立即以非零退出码结束，execFile
      // 等待退出码会误报失败，因此用 spawn 分离启动、不等待直接返回成功。
      // explorer 不认正斜杠路径，先转成 Windows 原生反斜杠路径。
      const winPath = realPath.replace(/\//g, "\\");
      const child = spawn("explorer.exe", [`/select,${winPath}`], { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => {
        // spawn 失败（找不到 explorer）——响应已返回 ok，无需处理
      });
      child.unref();
    } else if (process.platform === "darwin") {
      await execFileAsync("open", ["-R", realPath], { windowsHide: true });
    } else {
      await execFileAsync("xdg-open", [realPath.split("/").slice(0, -1).join("/") || "/"], { windowsHide: true });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  return NextResponse.json({ ok: true, filePath: realPath });
}
