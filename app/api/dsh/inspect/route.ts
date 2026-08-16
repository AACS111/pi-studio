import { NextResponse } from "next/server";

// 探测一个 DSH 生态目录里的 GitHub 仓库（owner/repo），识别它是否能一键安装：
//   - 单包 npm：根 package.json 的 name 非 private 且已发布 → npm install + Cordis 桥接
//   - monorepo：根 package.json private:true，经 git trees 找一级子包（packages/*）的
//     非 private npm 包 → 返回候选列表
//   - skill：仓库根目录有 SKILL.md → 下载到全局 skills 目录
// 探测走 api.github.com（raw.githubusercontent.com 国内常不可达）。

export const dynamic = "force-dynamic";

const GITHUB_API = "https://api.github.com";
const TTL_MS = 10 * 60 * 1000;
const USER_AGENT = "pi-studio/0.8 (dsh inspect)";
const MAX_MONOREPO_CANDIDATES = 12;

export interface DshInspectResult {
  repo: string;
  npmPackage: string | null;
  npmCandidates: string[];
  skill: { branch: string; path: string } | null;
  installable: boolean;
  reason: string;
}

const cache = new Map<string, { at: number; result: DshInspectResult }>();

function validRepo(repo: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(repo);
}

/** 经 GitHub Contents API 读一个文件，返回 base64 解码文本；404 返回 ok:false。 */
async function fetchGitHubFile(
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<{ ok: boolean; text?: string }> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github.v3+json" },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return { ok: false };
    if (!res.ok) return { ok: false };
    const json = (await res.json()) as { encoding?: string; content?: string };
    if (json.encoding === "base64" && typeof json.content === "string") {
      return { ok: true, text: Buffer.from(json.content, "base64").toString("utf8") };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** 经 GitHub git trees API 拿整个仓库的文件路径列表（recursive）。 */
async function fetchGitTree(owner: string, repo: string, branch: string): Promise<string[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github.v3+json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { truncated?: boolean; tree?: Array<{ path?: string }> };
    return (json.tree ?? []).map((t) => t.path ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchNpm(name: string): Promise<boolean> {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 从 git tree 里找 monorepo 一级子包（packages/<name>/package.json）的可安装 npm 包。 */
async function findMonorepoCandidates(owner: string, repo: string, branch: string): Promise<string[]> {
  const tree = await fetchGitTree(owner, repo, branch);
  // 一级子包：packages/<name>/package.json，排除 skins 等深层皮肤目录。
  const pkgPaths = tree.filter(
    (p) => /^packages\/[^/]+\/package\.json$/.test(p) && !/\/skins\//.test(p),
  );
  const candidates: string[] = [];
  for (const pkgPath of pkgPaths.slice(0, MAX_MONOREPO_CANDIDATES)) {
    const pkg = await fetchGitHubFile(owner, repo, branch, pkgPath);
    if (!pkg.ok || !pkg.text) continue;
    try {
      const parsed = JSON.parse(pkg.text) as { name?: unknown; private?: unknown };
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      if (!name || parsed.private === true) continue;
      if (await fetchNpm(name)) candidates.push(name);
    } catch {
      // ignore malformed package.json
    }
  }
  return candidates;
}

async function inspectRepo(repo: string): Promise<DshInspectResult> {
  const [owner, repoName] = repo.split("/");
  for (const branch of ["main", "master"]) {
    const pkg = await fetchGitHubFile(owner, repoName, branch, "package.json");
    if (pkg.ok && pkg.text) {
      try {
        const parsed = JSON.parse(pkg.text) as { name?: unknown; private?: unknown };
        const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
        const isPrivate = parsed.private === true;

        if (name && !isPrivate) {
          if (await fetchNpm(name)) {
            return { repo, npmPackage: name, npmCandidates: [], skill: null, installable: true, reason: `npm 包 ${name}（Cordis 桥接安装）` };
          }
          return { repo, npmPackage: name, npmCandidates: [], skill: null, installable: false, reason: `package.json 声明了 ${name}，但未发布到 npm registry` };
        }

        if (isPrivate) {
          const candidates = await findMonorepoCandidates(owner, repoName, branch);
          if (candidates.length > 0) {
            return {
              repo,
              npmPackage: null,
              npmCandidates: candidates,
              skill: null,
              installable: true,
              reason: `monorepo：发现 ${candidates.length} 个可安装 npm 包`,
            };
          }
          // 无候选，继续探测 SKILL.md
        }
      } catch {
        // 解析失败，继续探测 skill
      }
    }

    const skill = await fetchGitHubFile(owner, repoName, branch, "SKILL.md");
    if (skill.ok) {
      return { repo, npmPackage: null, npmCandidates: [], skill: { branch, path: "SKILL.md" }, installable: true, reason: "仓库根目录含 SKILL.md（skill 安装）" };
    }
  }
  return { repo, npmPackage: null, npmCandidates: [], skill: null, installable: false, reason: "未找到可安装的 npm 包或根目录 SKILL.md，无法一键安装" };
}

// POST /api/dsh/inspect  body: { repo: "owner/repo" }
export async function POST(req: Request) {
  let body: { repo?: string };
  try {
    body = (await req.json()) as { repo?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const repo = (body.repo ?? "").trim();
  if (!validRepo(repo)) {
    return NextResponse.json({ error: "invalid repo (expected owner/repo)" }, { status: 400 });
  }

  const cached = cache.get(repo);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json(cached.result);
  }

  try {
    const result = await inspectRepo(repo);
    cache.set(repo, { at: Date.now(), result });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
