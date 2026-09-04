#!/usr/bin/env node
/**
 * Pi Studio 智能 GitHub Release 发布脚本
 *
 * 用法:
 *   node scripts/release.mjs                     # 全自动：判断版本变化 → 决定是否重打包 → 创建/更新 Release + 上传 assets
 *   GH_TOKEN=<token> node scripts/release.mjs    # 显式传 token（或已设环境变量/--token）
 *   node scripts/release.mjs --notes-only        # 只更新现有 Release 的 notes，不重打包不上传
 *   node scripts/release.mjs --skip-pack         # 版本变了但用现有 release/ 产物（不重新打包）
 *
 * 智能逻辑（核心）:
 *   1. 读取 package.json 的 version
 *   2. 查 GitHub: 该 version 是否已对应一个 tag / release？
 *      - 尚未发布（新版本）→ 检查本地 release/ 是否有 <version> 的 exe
 *        * 没有 → 调 pnpm run pack 重新打包（next build + electron-builder）
 *        * 有   → 直接复用现成 exe（--skip-pack）
 *        然后: 打 tag → push → 创建 Release → 上传两个 exe assets → 写 notes
 *      - 已发布（版本没变）→ 不重新打包, 复用已有 assets，只更新 Release notes
 *
 * 依赖:
 *   - GitHub PAT token（--token / $GH_TOKEN / $GITHUB_TOKEN），需 repo 权限
 *   - curl 可访问 api.github.com（本脚本已内置用 curl 而非 gh）
 */
import { spawnSync } from "child_process";
import { readFileSync, existsSync, statSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = process.cwd();
const _dir = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const VERSION = pkg.version;
const REPO = "AACS111/pi-studio";
const TAG = `v${VERSION}`;
const PRODUCT = "Pi Studio";

const args = process.argv.slice(2);
const notesOnly = args.includes("--notes-only");
const skipPack = args.includes("--skip-pack");

// ---- 1. 解析 token ----
const token =
  (args.find((a) => a.startsWith("--token=")) || "").split("=")[1] ||
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN;

if (!token) {
  console.error(
    "[release] 未找到 GitHub token。请设置 GH_TOKEN 环境变量或用 --token=<PAT> 传入（需 repo 权限）。"
  );
  process.exit(1);
}
const AUTH = `Authorization: Bearer ${token}`;
const API_BASE = `https://api.github.com/repos/${REPO}`;

// ---- 2. 便捷 curl 函数（返回 JSON）----
function gh(method, url, body, extraHeaders = {}) {
  const args = ["-s", "-m", "90", "-X", method, "-H", AUTH, "-H", "Accept: application/vnd.github.v3+json"];
  let input = undefined;
  if (body !== undefined) {
    args.push("-H", "Content-Type: application/json", "--data-binary", "@-");
    input = JSON.stringify(body); // 经 stdin 传入，避免反引号/新行在 -d 参数里被 curl 误处理
  }
  const extra = Object.entries(extraHeaders).map(([k, v]) => ["-H", `${k}: ${v}`]).flat();
  const call = spawnSync("curl", [...args, ...extra, url], {
    input, encoding: "utf8", timeout: 90000,
  });
  if (call.status !== 0) {
    console.error(`[release] curl 失败 (${method} ${url}):`, call.stderr || `exit ${call.status}`);
    process.exit(1);
  }
  try {
    return JSON.parse(call.stdout || "{}");
  } catch {
    return {};
  }
}

// ---- 3. 查询远端 tag / release 状态 ----
const remoteTags = spawnSync("git", ["ls-remote", "--tags", "origin", TAG], {
  cwd: root, encoding: "utf8",
});
const tagExistsRemote = !!remoteTags.stdout.trim();

let existingRelease = null;
{
  const r = gh("GET", `${API_BASE}/releases/tags/${TAG}`);
  if (r.id) existingRelease = r;
}

const alreadyReleased = !!(
  existingRelease && !existingRelease.draft
);

console.log(`[release] version=${VERSION} tag=${TAG} tagOnRemote=${tagExistsRemote} releaseExists=${!!existingRelease}`);

// ---- 4. 判定是否需要重新打包 ----
// 规则: 版本对应的 release 已存在(已发布) → 不重打包; 否则(新版本/首次发布) → 确保有 exe
const needPack = !alreadyReleased;

const setupExe = resolve(root, "release", `${PRODUCT}-${VERSION}-setup.exe`);
const portableExe = resolve(root, "release", `${PRODUCT}-${VERSION}-portable.exe`);
const artifactsBuilt = existsSync(setupExe) && existsSync(portableExe);

if (needPack && !notesOnly) {
  if (!artifactsBuilt && !skipPack) {
    console.log("[release] 新版本 & 无现成 exe → 重新打包 `pnpm run pack`（耗时较长）...");
    const pack = spawnSync("pnpm", ["run", "pack"], { cwd: root, stdio: "inherit", timeout: 3600000 });
    if (pack.status !== 0) {
      console.error("[release] 打包失败，中止。可用 --skip-pack 改用已有产物。");
      process.exit(pack.status ?? 1);
    }
    console.log("[release] 打包完成。");
  } else if (!artifactsBuilt) {
    console.error(`[release] 未找到 exe: ${setupExe} 或 ${portableExe}。请先打包或用 --skip-pack 谨慎跳过。`);
    process.exit(1);
  }
} else if (alreadyReleased) {
  console.log("[release] 版本未变(该 release 已发布) → 不重新打包，仅更新 notes/走 notes-only 逻辑。");
}

// ---- 5. 生成 release notes（基于 git 历史）----
function currentBranch() {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" });
  return r.stdout.trim();
}
// 上一个版本 tag（若无则以 HEAD~ 起算）
function prevTag() {
  const r = spawnSync("git", ["describe", "--tags", "--abbrev=0", `${TAG}^`], {
    cwd: root, encoding: "utf8",
  });
  if (r.status === 0 && r.stdout.trim() && r.stdout.trim() !== TAG) return r.stdout.trim();
  const r2 = spawnSync("git", ["tag", "--sort=-creatordate", "--list"], { cwd: root, encoding: "utf8" });
  const tags = r2.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  return tags[1] || ""; // tags[0] 可能是当前 tag
}
const base = prevTag();
const range = base ? `${base}..${TAG}` : "";
const commits = spawnSync(
  "git",
  range ? ["log", "--oneline", "--no-decorate", range] : ["log", "--oneline", "--no-decorate", "-20"],
  { cwd: root, encoding: "utf8" }
).stdout.split("\n").map((s) => s.trim()).filter(Boolean);

const feat = [], fix = [], chore = [];
for (const c of commits) {
  const [hash, ...rest] = c.split(/\s+/, 2);
  const msg = c.replace(/^[a-f0-9]{7,}\s*/, "");
  if (/^feat|^fix|^chore|^build|^docs|^refactor|^perf|^test|^style/i.test(msg)) {
    const type = msg.split(":")[0].toLowerCase();
    const line = `- \`${hash}\` ${msg}`;
    if (/^feat|^build/i.test(type)) feat.push(line);
    else if (/^fix/i.test(type)) fix.push(line);
    else chore.push(line);
  } else {
    chore.push(`- \`${hash}\` ${msg}`);
  }
}

const block = (title, items) =>
  items.length ? `### ${title}\n\n${items.join("\n")}\n` : "";

const notes = `## 中文

本次发布版本 \`${TAG}\`。

${block("新增", feat)}${block("修复", fix)}${block("改进/其他", chore)}
## English

Release \`${TAG}\`.

${block("Added", feat)}${block("Fixed", fix)}${block("Improved / Other", chore)}`;

// ---- 6. 执行发布 ----
if (notesOnly) {
  if (!existingRelease) {
    console.error("[release] --notes-only 但该 release 不存在（无法仅更新 notes）。");
    process.exit(1);
  }
  console.log("[release] 仅更新 notes...");
  const upd = gh("PATCH", `${API_BASE}/releases/${existingRelease.id}`, { body: notes });
  console.log(`[release] notes 已更新 → ${upd.html_url || upd.id || upd}`);
  process.exit(0);
}

if (!tagExistsRemote) {
  console.log(`[release] 创建并 push tag ${TAG}...`);
  const t = spawnSync("git", ["tag", "-a", TAG, "-m", TAG], { cwd: root, encoding: "utf8" });
  if (t.status !== 0) { console.error(t.stderr); process.exit(1); }
  const p = spawnSync("git", ["push", "origin", TAG], { cwd: root, encoding: "utf8" });
  if (p.status !== 0) { console.error("[release] tag push 失败:", p.stderr); process.exit(1); }
}

let release = existingRelease;
if (!release) {
  console.log("[release] 创建 Release...");
  release = gh("POST", `${API_BASE}/releases`, {
    tag_name: TAG,
    name: TAG,
    body: notes,
    draft: false,
    prerelease: false,
  });
  if (!release.id) {
    console.error("[release] 创建 Release 失败:", JSON.stringify(release));
    process.exit(1);
  }
  console.log(`[release] Release 已创建 → ${release.html_url}`);
} else {
  console.log("[release] 更新已有 Release 的 notes...");
  release = gh("PATCH", `${API_BASE}/releases/${release.id}`, { body: notes });
  console.log(`[release] notes 已更新 → ${release.html_url}`);
}

if (!alreadyReleased) {
  // 上传 assets（仅新版本时上传/覆盖 exe）
  const uploadUrl = `${release.upload_url.replace("{?name,label}", "")}`;
  for (const f of [setupExe, portableExe]) {
    if (!existsSync(f)) {
      console.warn(`[release] 跳过上传(文件不存在): ${f}`);
      continue;
    }
    const size = statSync(f).size;
    const name = f.split(/[\\/]/).pop();
    console.log(`[release] 上传 ${name} (${(size / 1048576).toFixed(1)} MB)...`);
    const up = spawnSync(
      "curl",
      [
        "-s", "-m", "600", "-X", "POST",
        "-H", AUTH,
        "-H", "Content-Type: application/octet-stream",
        "-H", `Content-Length: ${size}`,
        "-H", "Accept: application/vnd.github.v3+json",
        "--data-binary", `@${f}`,
        `${uploadUrl}?name=${encodeURIComponent(name)}`,
      ],
      { encoding: "utf8", timeout: 610000 }
    );
    if (up.status !== 0 || !JSON.parse(up.stdout || "{}").id) {
      console.error(`[release] 上传 ${name} 失败:`, up.stderr || up.stdout);
    } else {
      console.log(`[release] 已上传 ${name}`);
    }
  }
}

console.log("\n[release] 完成 ✅");
console.log(`  Tag:        ${process.env.GITHUB_SERVER_URL || "https://github.com"}/${REPO}/tag/${TAG}`);
console.log(`  Release:    ${release.html_url}`);