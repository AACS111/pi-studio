import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, normalize, resolve } from "path";
import { getInternalDir } from "@/lib/storage-config";

/**
 * 「添加项目」持久登记表。
 *
 * 侧栏项目列表历史上完全由会话派生（getRecentProjects(/api/sessions)），
 * 「添加项目」只是切换 cwd：目录里产生第一条会话前，项目不会出现在列表里。
 * 本模块把用户显式添加的目录登记到数据目录的 .internal/registered-projects.json
 * （随数据目录持久化，dev / 打包 exe 各自独立），项目列表 = 会话派生 ∪ 登记表，
 * 实现「添加即显示、重启仍在」。
 */

interface RegisteredProject {
  path: string;
  addedAt: string;
}

const REGISTRY_FILE = "registered-projects.json";

/** 与 /api/projects/delete 一致的比较规则：分隔符统一、去尾斜杠、大小写不敏感（Windows） */
function normalizeForCompare(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 与 /api/cwd/validate 一致的路径归一（~ 展开、相对路径解析、斜杠规范化） */
function normalizeCwd(cwd: string): string {
  if (cwd === "~") return normalize(homedir());
  if (cwd.startsWith("~/")) return normalize(resolve(homedir(), cwd.slice(2)));
  return normalize(isAbsolute(cwd) ? cwd : resolve(cwd));
}

function readRegistry(): RegisteredProject[] {
  try {
    const raw = readFileSync(join(getInternalDir(), REGISTRY_FILE), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RegisteredProject =>
        !!e && typeof e === "object" && typeof (e as RegisteredProject).path === "string",
    );
  } catch {
    return []; // 文件不存在/损坏 → 视为空登记表（下次写入重建）
  }
}

function writeRegistry(entries: RegisteredProject[]): void {
  mkdirSync(getInternalDir(), { recursive: true });
  writeFileSync(join(getInternalDir(), REGISTRY_FILE), JSON.stringify(entries, null, 2), "utf8");
}

/** 已登记的项目路径（新添加的在前）。 */
export function listRegisteredProjects(): string[] {
  return readRegistry().map((e) => e.path);
}

/**
 * 登记一个项目目录（存在性校验 + 去重；重复登记会把它移到最前）。
 * 返回登记后的完整列表。目录不存在/不是目录时抛错（路由映射为 400）。
 */
export function registerProject(cwd: string): string[] {
  const normalized = normalizeCwd(cwd.trim());
  let stat;
  try {
    stat = statSync(normalized);
  } catch {
    throw new Error(`Directory does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${cwd}`);
  }
  const key = normalizeForCompare(normalized);
  const entries = readRegistry().filter((e) => normalizeForCompare(e.path) !== key);
  entries.unshift({ path: normalized, addedAt: new Date().toISOString() });
  writeRegistry(entries);
  return entries.map((e) => e.path);
}

/** 取消登记（幂等）。返回登记后的完整列表。 */
export function unregisterProject(cwd: string): string[] {
  const key = normalizeForCompare(cwd.trim());
  const entries = readRegistry().filter((e) => normalizeForCompare(e.path) !== key);
  writeRegistry(entries);
  return entries.map((e) => e.path);
}
