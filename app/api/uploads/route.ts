import { NextRequest, NextResponse } from "next/server";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { parseFormDataWithinLimit } from "@/lib/bounded-form-data";
import { setDataDir } from "@/lib/storage-config";
import {
  deleteUpload,
  getUploadPath,
  getUploadsDir,
  getUploadsStats,
  writeUpload,
} from "@/lib/uploads";

const execFileAsync = promisify(execFile);

/**
 * /api/uploads — pi-studio 上传附件（.xlsx / .univer / 图片等）的隔离存储区管理。
 *
 * GET  /api/uploads                          → 文件列表 + 容量统计 + 当前目录 dir
 * GET  /api/uploads?download=<name>          → 下载文件
 * DELETE /api/uploads?name=<name>            → 删除文件
 * POST /api/uploads                          → multipart 上传（files 字段）
 * POST /api/uploads?open=1                   → 在系统文件管理器中打开该目录
 * POST /api/uploads?dir=<path>               → 修改存储目录（空值恢复默认，写入 .pi-web-config.json）
 */

/** 校验并确保目录可写：不存在则创建，写入一个探针文件再删除。 */
function ensureWritableDir(raw: string): string | null {
  const dir = setDataDir(raw);
  try {
    const probeDir = mkdtempSync(join(dir, ".probe-"));
    writeFileSync(join(probeDir, "w.tmp"), "ok");
    rmSync(probeDir, { recursive: true, force: true });
    return dir;
  } catch {
    return null;
  }
}
export async function GET(request: NextRequest) {
  const download = request.nextUrl.searchParams.get("download")?.trim() ?? "";
  if (download) {
    const full = getUploadPath(download);
    if (!full) return NextResponse.json({ error: "File not found" }, { status: 404 });
    try {
      const { readFileSync } = await import("fs");
      const bytes = readFileSync(full);
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download)}`,
        },
      });
    } catch {
      return NextResponse.json({ error: "Failed to read file" }, { status: 500 });
    }
  }

  return NextResponse.json(getUploadsStats());
}

export async function POST(request: NextRequest) {
  const dirParam = request.nextUrl.searchParams.get("dir");
  const open = request.nextUrl.searchParams.get("open");

  // 修改存储目录：POST /api/uploads?dir=<path>（空值恢复默认）。
  // 校验可写后才持久化，避免把配置写成不可用的目录。
  if (dirParam !== null) {
    const newDir = ensureWritableDir(dirParam);
    if (!newDir) {
      return NextResponse.json({ error: "Directory is not writable" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, dir: newDir, reset: !dirParam.trim() });
  }

  if (open !== null) {
    // 在系统文件管理器中打开上传目录（Windows: explorer；macOS: open；Linux: xdg-open）。
    const dir = getUploadsDir();
    try {
      if (process.platform === "win32") {
        // explorer.exe 是 GUI 程序：成功打开目录后也会立即以非零退出码结束，
        // execFile 等待退出码会误报 "Command failed: explorer ..."。
        // 因此用 spawn 分离启动，不等待其退出，直接返回成功。
        // 注意：explorer 不认正斜杠路径（只打开文件管理器却不跳转到目标目录），
        // 必须先转成 Windows 原生反斜杠路径。
        const winDir = dir.replace(/\//g, "\\");
        const child = spawn("explorer", [winDir], { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => {
          // spawn 本身失败（如找不到 explorer）——响应已返回 ok，无需处理
        });
        child.unref();
      } else if (process.platform === "darwin") {
        await execFileAsync("open", [dir], { windowsHide: true });
      } else {
        await execFileAsync("xdg-open", [dir], { windowsHide: true });
      }
      return NextResponse.json({ ok: true, dir });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }

  try {
    const formData = await parseFormDataWithinLimit(request, 32 * 1024 * 1024);
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (!files.length) return NextResponse.json({ error: "No files selected" }, { status: 400 });

    const uploaded: Array<{ name: string; path: string; size: number; kind: string }> = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const file of files) {
      try {
        const bytes = Buffer.from(await file.arrayBuffer());
        const result = writeUpload(file.name, bytes);
        uploaded.push({
          name: result.name,
          path: result.path,
          size: bytes.length,
          kind: result.name.split(".").pop() ?? "",
        });
      } catch (error) {
        errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return NextResponse.json({ uploaded, errors }, { status: errors.length ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name")?.trim() ?? "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const ok = deleteUpload(name);
  if (!ok) return NextResponse.json({ error: "File not found" }, { status: 404 });
  return NextResponse.json({ ok: true, name });
}
