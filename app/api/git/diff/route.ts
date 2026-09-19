import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitFileDiff } from "@/lib/git-changes";
import { resolveSessionPath, getSessionEntries, readSessionHeader } from "@/lib/session-reader";
import {
  collectFileMutations,
  computeBaseline,
  canUseDiskContent,
  generateNoIndexPatch,
} from "@/lib/session-reconstruct";

/**
 * 单文件 diff。优先 git（工作区 vs HEAD）——语义是「这次会话之前更早的
 * 历史」；git 不可用（非 git 仓库 / 改动已提交 / status 里不存在）时，
 * 回退到会话记录重构：撤销本会话对该文件的 edit/write，得到「会话开始
 * 时」的内容，与当前盘上内容对比。两者的响应形状一致（`supported /
 * status / patch / exists`），前端 FileViewer 无感知。
 *
 * 已知局限（安全降级为 supported:false，绝不出错误 diff）：
 * - bash 直接写文件产生的漂移会让 newText 匹配失败 → 中止；
 * - write 之前的更早历史不可回退（只能回退到最近一次 write）。
 */
export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const filePath = request.nextUrl.searchParams.get("path")?.trim() ?? "";
    const sessionId = request.nextUrl.searchParams.get("sessionId")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    // The cwd must resolve inside an allowed root. The file itself may no
    // longer exist when Git reports it as deleted; getGitFileDiff verifies
    // that the requested path belongs to this repository and its status.
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const diff = await getGitFileDiff(cwd, filePath);
    // Report whether the file still exists so the changed-files card can hide
    // scratch scripts the agent wrote and then deleted (they are not in git
    // status and would otherwise linger as empty rows).
    let exists = true;
    try {
      exists = fs.existsSync(filePath);
    } catch {
      exists = false;
    }
    if (diff.supported) return NextResponse.json({ ...diff, exists });

    // ---- 回退：会话记录重构（非 git 仓库 / 已提交 / 不在 status 里）——
    if (!sessionId) return NextResponse.json({ ...diff, exists });

    let sessionFile: string | null = null;
    try {
      sessionFile = await resolveSessionPath(sessionId);
    } catch {
      sessionFile = null;
    }
    if (!sessionFile) return NextResponse.json({ ...diff, exists });

    let headerCwd: string | null = null;
    try {
      headerCwd = readSessionHeader(sessionFile)?.cwd ?? null;
    } catch {
      headerCwd = null;
    }
    // 会话 cwd 与请求的 cwd 不一致时不可信（文件归属判断会错），保持回退失败。
    if (!headerCwd || !isWindowsAbsolutePath(headerCwd) && !headerCwd.startsWith("/")) {
      return NextResponse.json({ ...diff, exists });
    }

    try {
      const entries = getSessionEntries(sessionFile) as unknown as Array<Record<string, unknown>>;
      const mutations = collectFileMutations(entries, headerCwd, filePath);
      if (mutations.length === 0) return NextResponse.json({ ...diff, exists });

      let currentBuffer: Buffer;
      try {
        currentBuffer = fs.readFileSync(filePath);
      } catch {
        return NextResponse.json({ ...diff, exists });
      }
      if (!canUseDiskContent(filePath, currentBuffer)) return NextResponse.json({ ...diff, exists });
      const current = currentBuffer.toString("utf8");

      const baseline = computeBaseline(mutations, normalizeInput(current));
      if (!baseline.ok || typeof baseline.baseline !== "string") {
        return NextResponse.json({ ...diff, exists });
      }

      const patch = await generateNoIndexPatch(baseline.baseline, normalizeInput(current));
      if (!patch) return NextResponse.json({ ...diff, exists });
      // `git diff --no-index a b` 的头部路径是临时文件名，替换为真实路径，
      // 与 git 路径下 getGitFileDiff 的 patch 头一致（文件名可读）。
      const relPath = patchHeaderPath(cwd, filePath);
      const rewrite = patch
        .replace(/^diff --git a\/a b\/b$/m, `diff --git a/${relPath} b/${relPath}`)
        .replace(/^--- a\/a$/m, `--- a/${relPath}`)
        .replace(/^\+\+\+ b\/b$/m, `+++ b/${relPath}`);

      return NextResponse.json({
        supported: true,
        status: firstMutationKind(mutations) === "write" ? "added" : "modified",
        patch: rewrite,
        exists,
      });
    } catch {
      return NextResponse.json({ ...diff, exists });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function normalizeInput(text: string): string {
  let out = text;
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  return out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function firstMutationKind(mutations: Array<{ kind: string }>): string {
  return mutations[0]?.kind === "write" ? "write" : "edit";
}

function pathRelativeSafe(from: string, to: string): string | null {
  try {
    const rel = path.relative(from, to);
    return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : null;
  } catch {
    return null;
  }
}
function patchHeaderPath(cwd: string, filePath: string): string {
  // 与 git 版一致：用相对 cwd 的路径作为 patch 头（不做盘符大小写整形）。
  const rel = pathRelativeSafe(cwd, filePath);
  return rel ?? filePath;
}
