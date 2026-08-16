/**
 * DSH 插件存储：把 DSH 插件 npm 安装到 Pi 的隔离目录（不再用 sidecar 的 DSH_HOME）。
 *
 * 安装时显式带上核心服务包（cordis + dsh-fs/tools/system-prompt 等），保证
 * 插件声明的 peer 依赖能被同一版本满足（Pi 宿主提供 Cordis 运行时，插件侧
 * 依赖 dsh-fs/dsh-tools/dsh-system-prompt 等，见 docs/dsh/README.md）。
 */
import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { getInternalDir } from "@/lib/storage-config";
import { resolveNpmInvocation } from "@/lib/npx";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";

const STORE_DIR = join(getInternalDir(), "dsh-plugins");

/** 核心服务包：随插件一起安装，保证 peer 版本一致（POC 验证过的集合）。 */
const CORE_DEPS = [
  "@deepseek-ai/cordis@4.0.1",
  "@deepseek-ai/dsh-fs",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-sandbox",
  "@deepseek-ai/dsh-sandbox-policy",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-invariants",
  "@deepseek-ai/dsh-user-approval",
  "@deepseek-ai/dsh-brand",
  "@deepseek-ai/schemastery",
];

export function getDshPluginStoreDir(): string {
  try {
    mkdirSync(STORE_DIR, { recursive: true });
  } catch {
    // ignore
  }
  return STORE_DIR;
}

function pluginsFile(): string {
  return join(getInternalDir(), "pi-web-dsh-plugins.json");
}

/** 用户安装的 DSH 插件包名（不含核心服务包）。 */
export function listInstalledPlugins(): string[] {
  try {
    if (!existsSync(pluginsFile())) return [];
    const parsed = JSON.parse(readFileSync(pluginsFile(), "utf8")) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // ignore
  }
  return [];
}

function saveInstalled(installed: string[]): void {
  try {
    writePrivateFileAtomicSync(pluginsFile(), JSON.stringify(installed, null, 2));
  } catch {
    // ignore
  }
}

/** 插件包的本地绝对路径（安装目录里的 node_modules/<pkg>）。 */
export function pluginModulePath(pkg: string): string {
  return join(getDshPluginStoreDir(), "node_modules", ...pkg.split("/"));
}

export function isPluginInstalled(pkg: string): boolean {
  return existsSync(join(pluginModulePath(pkg), "package.json"));
}

function runNpm(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const { command, commandArgs, useShell } = resolveNpmInvocation(args);
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
    });
    let out = "";
    const onData = (buf: Buffer) => {
      out = (out + buf.toString()).slice(-4000);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, output: (out + "\n[tool-fs] install timed out after 5m").slice(-2000) });
    }, 300_000);
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: err.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.slice(-2000) || `exit ${code ?? "?"}` });
    });
  });
}

/** 安装一个 DSH 插件包（含核心服务包）。 */
export async function installPlugin(pkg: string): Promise<{ ok: boolean; output: string }> {
  const safe = pkg.trim();
  if (!safe || !/^[\w@./-]+$/.test(safe)) return { ok: false, output: "invalid package name" };
  const storeDir = getDshPluginStoreDir();
  const result = await runNpm(
    ["install", "--prefix", storeDir, "--no-audit", "--no-fund", "--loglevel=error", safe, ...CORE_DEPS],
    dirname(storeDir),
  );
  if (result.ok) {
    const installed = listInstalledPlugins();
    if (!installed.includes(safe)) {
      installed.push(safe);
      saveInstalled(installed);
    }
  }
  return result;
}

/** 移除一个 DSH 插件包。 */
export async function removePlugin(pkg: string): Promise<{ ok: boolean; output: string }> {
  const safe = pkg.trim();
  if (!safe) return { ok: false, output: "package required" };
  const storeDir = getDshPluginStoreDir();
  const result = await runNpm(
    ["uninstall", "--prefix", storeDir, "--no-audit", "--no-fund", "--loglevel=error", safe],
    dirname(storeDir),
  );
  if (result.ok) {
    saveInstalled(listInstalledPlugins().filter((p) => p !== safe));
  }
  return result;
}

/** 从包的 package.json 解析入口文件（exports 优先，回退 main，回退 index.js）。 */
function resolvePluginEntryFile(pkg: string): string {
  const pkgDir = pluginModulePath(pkg);
  try {
    const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      main?: string;
      module?: string;
      exports?: Record<string, unknown>;
    };
    const dot = pkgJson.exports?.["."];
    let entry: string | undefined;
    if (typeof dot === "string") {
      entry = dot;
    } else if (dot && typeof dot === "object") {
      const map = dot as Record<string, unknown>;
      entry = (map.default ?? map.import ?? map.require) as string | undefined;
    }
    entry ??= pkgJson.module ?? pkgJson.main ?? "index.js";
    return join(pkgDir, entry);
  } catch {
    return join(pkgDir, "index.js");
  }
}

/** 动态 import 一个已安装的 DSH 插件模块。 */
export async function loadPluginModule(pkg: string): Promise<unknown> {
  if (!isPluginInstalled(pkg)) {
    throw new Error(`DSH plugin "${pkg}" is not installed`);
  }
  const entryFile = resolvePluginEntryFile(pkg);
  const url = pathToFileURL(entryFile).href;
  // Next.js webpack 无法静态分析 import() 的动态路径（"expression is too
  // dynamic"），用 new Function 让 import 在运行时才求值，绕过 webpack 的打包。
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  return dynamicImport(url);
}
