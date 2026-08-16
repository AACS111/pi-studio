import { execFile } from "child_process";
import { promisify } from "util";
import { access as accessFile } from "fs/promises";
import { constants, existsSync, readFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { execPath } from "process";

/**
 * pi-studio 应用自身的版本检查与自动更新。
 *
 * 应用以 npm 全局包发布（@aacs111/pi-studio，bin: pi-studio，携带 .next 构建产物），
 * 所以「更新 pi-studio」= `npm install -g <name>@<latest>`。
 * 源码/开发模式（npm run dev / dev:electron，从本仓库运行）不做自动更新，
 * 提示用户 git pull && npm install 手动更新。
 *
 * 注意：升级只替换磁盘上的安装，正在运行的进程仍是旧代码，需重启应用才生效。
 * pi 引擎（@earendil-works/*）不在此更新范围 —— 引擎版本由应用发布时锁定。
 */

const LATEST_VERSION_URL_PREFIX = "https://registry.npmjs.org/";
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

const execFileAsync = promisify(execFile);

export interface AppUpdateInfo {
  /** 当前运行的 pi-studio 版本（package.json） */
  current: string;
  /** npm 上最新发布版本；未发布/网络失败时为 null */
  latest: string | null;
  updateAvailable: boolean;
  /** 应用是否已发布到 npm */
  published: boolean;
  /** npm 包名（读 package.json name） */
  packageName: string;
  changelogUrl: string;
  /** 安装方式：全局 npm 安装 / 源码运行 */
  installMode: "global" | "source";
  /** 是否支持一键自动更新（全局安装 + 目录可写） */
  canAutoUpdate: boolean;
  unavailableReason?: string;
  /** 运行中 pi 引擎的兼容性自检结果（若引擎被手动改动，这里会给出警告） */
  compat: { ok: boolean; piVersion: string; errors: string[] };
}

export interface AppUpdateResult {
  updatedFrom: string;
  updatedTo: string;
  /** 请求的目标版本 */
  targetVersion: string;
  /** npm 输出（用于诊断） */
  output: string;
  /** 磁盘已更新，但运行中的进程仍是旧代码，需重启生效 */
  needsRestart: true;
}

/** Next dev/start 的 cwd 即项目根；全局安装时是 <prefix>/node_modules/<name> */
export function getAppRoot(): string {
  return resolve(process.cwd());
}

/** 读取应用自身的版本号 */
export function getAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(getAppRoot(), "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 读取应用包名 */
export function getAppPackageName(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(getAppRoot(), "package.json"), "utf8")) as { name?: unknown };
    return typeof pkg.name === "string" && pkg.name ? pkg.name : "@aacs111/pi-studio";
  } catch {
    return "@aacs111/pi-studio";
  }
}

/** 简单 semver 比较：0.8.6 < 0.9.0；不支持预发布标签 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * 定位 npm-cli.js，由当前 node 直接调用，避免 Windows 上 spawn `npm.cmd`
 * 的 shell 引号坑（与 lib/npx.ts 同一策略）。
 *
 * 查找顺序：
 *  1. npm_execpath 环境变量 — npm 运行脚本时总会设置它；`npm run dev` /
 *     `npm run dev:electron` 启动的 Next 服务都会继承到真实 npm-cli.js 路径。
 *  2. 按 process.execPath 布局推断 — 纯 node 启动（next start / CLI）时有效。
 *  3. Windows 上 `cmd /c npm root -g`（固定参数、无用户输入）查全局 npm。
 */
function findNpmCli(): string | null {
  const envPath = process.env.npm_execpath;
  if (envPath) {
    try {
      if (existsSync(envPath)) return envPath;
    } catch { /* ignore */ }
  }
  const nodeDir = dirname(execPath);
  const candidates = [
    // Windows MSI 布局：node.exe 与 node_modules 同目录
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    // Unix 布局：.../bin/node + .../lib/node_modules/npm/bin/npm-cli.js
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

/** 兜底：Windows 上经 cmd（固定参数，无用户输入）查全局 npm 根目录 */
async function findNpmCliGlobal(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync("cmd.exe", ["/c", "npm root -g"], {
      windowsHide: true,
      timeout: 15_000,
    });
    const root = stdout.trim();
    if (!root) return null;
    const cli = join(root, "npm", "bin", "npm-cli.js");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

async function resolveNpmCli(): Promise<string | null> {
  return findNpmCli() ?? (await findNpmCliGlobal());
}

/** 从 npm registry 拉取应用最新版本；未发布时返回 null */
export async function getLatestAppVersion(): Promise<string | null> {
  const name = getAppPackageName();
  try {
    const res = await fetch(`${LATEST_VERSION_URL_PREFIX}${encodeURIComponent(name)}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" && data.version ? data.version : null;
  } catch {
    return null;
  }
}

/** 安装方式：全局 npm 包 / 源码运行（看应用根目录的父目录是不是 node_modules） */
export function detectInstallMode(): "global" | "source" {
  const parent = basename(dirname(getAppRoot()));
  return parent === "node_modules" ? "global" : "source";
}

/** 全局安装前缀：<prefix>/node_modules/<scope>/<name> → <prefix> */
function getGlobalPrefix(): string | null {
  const root = getAppRoot();
  const parts = root.split(/[\\/]/);
  const nmIdx = parts.lastIndexOf("node_modules");
  if (nmIdx < 0) return null;
  return parts.slice(0, nmIdx).join("/") || "/";
}

/** 检查更新：当前 vs npm 最新 + 安装方式 + 兼容性自检 */
export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  const current = getAppVersion();
  const latest = await getLatestAppVersion();
  const published = latest !== null;
  const installMode = detectInstallMode();
  const auto = await checkAutoUpdateAvailable(installMode);
  const { checkPiCompat } = await import("./pi-compat-check");
  const compat = await checkPiCompat();
  const name = getAppPackageName();
  const repo = process.env.PI_STUDIO_REPO_URL ?? "https://github.com/AACS111/pi-studio";
  return {
    current,
    latest,
    updateAvailable: latest ? compareVersions(latest, current) > 0 : false,
    published,
    packageName: name,
    changelogUrl: `${repo}/releases`,
    installMode,
    canAutoUpdate: auto.ok,
    unavailableReason: auto.reason,
    compat,
  };
}

/** 检查当前安装是否可自动更新（全局安装 + 目录可写） */
export async function checkAutoUpdateAvailable(installMode?: "global" | "source"): Promise<{ ok: boolean; reason?: string }> {
  const mode = installMode ?? detectInstallMode();
  if (mode !== "global") {
    return { ok: false, reason: "source checkout: run git pull && npm install manually" };
  }
  try {
    await accessFile(getAppRoot(), constants.W_OK);
    return { ok: true };
  } catch {
    return { ok: false, reason: "install directory is read-only" };
  }
}

// Next.js 热重载下 module 级状态会丢，用 globalThis 串行并发更新
declare global {
  var __piStudioUpdatePromise: Promise<AppUpdateResult> | undefined;
}

/** 执行应用自更新（并发调用共享同一个 Promise，天然串行） */
export async function runAppUpdate(targetVersion?: string): Promise<AppUpdateResult> {
  if (globalThis.__piStudioUpdatePromise) return globalThis.__piStudioUpdatePromise;
  const p = performUpdate(targetVersion);
  globalThis.__piStudioUpdatePromise = p;
  try {
    return await p;
  } finally {
    globalThis.__piStudioUpdatePromise = undefined;
  }
}

async function performUpdate(targetVersion?: string): Promise<AppUpdateResult> {
  const current = getAppVersion();
  const npmCli = await resolveNpmCli();
  if (!npmCli) {
    throw new Error("npm not found (npm-cli.js missing in this Node/Electron installation)");
  }
  const { ok, reason } = await checkAutoUpdateAvailable();
  if (!ok) {
    throw new Error(reason ?? "auto-update unavailable in this install");
  }
  let version = targetVersion;
  if (!version) {
    const latest = await getLatestAppVersion();
    if (!latest) throw new Error("Failed to fetch the latest version from npm registry");
    version = latest;
  }
  if (compareVersions(version, current) <= 0) {
    throw new Error(`Already on pi-studio ${current} (target ${version})`);
  }
  const name = getAppPackageName();
  const prefix = getGlobalPrefix();
  const npmArgs = [
    npmCli,
    "install",
    "-g",
    ...(prefix ? ["--prefix", prefix] : []),
    `${name}@${version}`,
    "--save-exact",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ];
  const { stdout, stderr } = await execFileAsync(execPath, npmArgs, {
    cwd: getAppRoot(),
    timeout: UPDATE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  const updatedTo = getAppVersion();
  if (compareVersions(updatedTo, current) <= 0) {
    throw new Error(
      `Update did not take effect: still on ${updatedTo}. Output: ${(stdout + stderr).slice(0, 2000)}`,
    );
  }
  return { updatedFrom: current, updatedTo, targetVersion: version, output: `${stdout}\n${stderr}`.trim(), needsRestart: true };
}
