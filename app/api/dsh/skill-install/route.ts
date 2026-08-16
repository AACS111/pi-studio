import { NextResponse } from "next/server";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// 从 GitHub 仓库安装一个 skill：下载根目录 SKILL.md 到全局 skills 目录
// （~/.agents/skills/<name>/SKILL.md），让 pi 的 DefaultResourceLoader 发现它。
// 基础版：只下载 SKILL.md 主体（scripts/ 与 references/ 的下载是后续增强）。

export const dynamic = "force-dynamic";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "pi-studio/0.8 (dsh skill-install)";

function validRepo(repo: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(repo);
}

function sanitizeSkillName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "dsh-skill";
}

function globalSkillsDir(): string {
  const dir = join(homedir(), ".agents", "skills");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// POST /api/dsh/skill-install  body: { repo: "owner/repo", branch: "main", path: "SKILL.md" }
export async function POST(req: Request) {
  let body: { repo?: string; branch?: string; path?: string };
  try {
    body = (await req.json()) as { repo?: string; branch?: string; path?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const repo = (body.repo ?? "").trim();
  const branch = (body.branch ?? "main").trim();
  const skillPath = (body.path ?? "SKILL.md").trim();
  if (!validRepo(repo)) {
    return NextResponse.json({ error: "invalid repo (expected owner/repo)" }, { status: 400 });
  }

  const [owner, repoName] = repo.split("/");
  // 经 GitHub Contents API（raw.githubusercontent.com 国内常不可达）。
  const url = `${GITHUB_API}/repos/${owner}/${repoName}/contents/${skillPath}?ref=${branch}`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github.v3+json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 403) {
      return NextResponse.json(
        { error: "GitHub API rate limit exceeded（未认证 60 次/小时），请稍后再试" },
        { status: 502 },
      );
    }
    if (!res.ok) {
      return NextResponse.json(
        { error: `下载 SKILL.md 失败：HTTP ${res.status}` },
        { status: 502 },
      );
    }
    const json = (await res.json()) as { encoding?: string; content?: string };
    const content = json.encoding === "base64" && typeof json.content === "string"
      ? Buffer.from(json.content, "base64").toString("utf8")
      : "";
    if (!content.trim()) {
      return NextResponse.json({ error: "SKILL.md 内容为空" }, { status: 502 });
    }

    const skillName = sanitizeSkillName(repoName);
    const dir = join(globalSkillsDir(), skillName);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "SKILL.md");
    const existed = existsSync(target);
    writeFileSync(target, content, "utf8");

    return NextResponse.json({
      success: true,
      skillName,
      path: target,
      existed,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
