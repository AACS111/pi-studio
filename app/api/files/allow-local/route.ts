import { NextRequest, NextResponse } from "next/server";
import { statSync } from "fs";
import path from "path";
import { allowFileRoot, normalizeSlashes } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PATH_LENGTH = 2048;

/**
 * POST /api/files/allow-local { path } — 用户在任务区（右栏首页卡片）通过
 * 系统「打开文件」对话框 / 文件选择器显式挑选的本地文件，把其父目录临时
 * 加入本次进程的可读根（allowFileRoot），随后 /api/files 才能正常伺服该文件。
 *
 * 安全边界 = 用户在原生对话框里的主动选择（一次对话框授权一个目录），
 * 与 /api/cwd/validate、/api/agent/new 对 cwd 的 allowFileRoot 用法一致；
 * 根仅存内存，重启后失效。与 open-file-request 不同：那是 Agent 推文件，
 * 必须预先在允许根内；这里是用户亲手挑的盘上任意文件，天然可信。
 */
export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as { path?: unknown } | null;
  const raw = typeof body?.path === "string" ? body.path.trim() : "";
  if (!raw || raw.length > MAX_PATH_LENGTH) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  const normalized = normalizeSlashes(raw);
  const isAbsolute =
    /^[a-zA-Z]:[\\/]/.test(raw) ||
    raw.startsWith("\\\\") ||
    normalized.startsWith("//") ||
    normalized.startsWith("/");
  if (!isAbsolute) {
    return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
  }

  let isFile = false;
  try {
    isFile = statSync(raw).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  allowFileRoot(path.dirname(path.resolve(raw)));
  return NextResponse.json({ ok: true, path: normalized });
}
