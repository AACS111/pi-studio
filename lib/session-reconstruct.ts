/**
 * 会话记录重构 diff 基线 —— 不依赖 git 仓库。
 *
 * 语义：重建「该文件在本会话开始时」的内容，与当前磁盘内容对比。
 * 数据源：会话 jsonl 的当前分支（tip 起 parentId 链）里，对该文件的
 * 已完成 edit / write 工具调用（edit: 精确 oldText/newText 替换对；
 * write: 整篇覆写）。倒序撤销这些修改即得到基线。
 *
 * 已知局限（接受，见 git/diff 路由注释）：
 * - bash 等间接写文件无法重构（基线在撤销到那一步时因 newText 匹配
 *   失败而中止，返回 !ok —— 安全降级，不出错误 diff）；
 * - write 之后的 edit 可回退到该 write，write 之前的不可回退；
 * - 首 mutation 为 write 或 write 到达基线位置时，write.content 即基线
 *   （新建文件约定：本分支内第一次改动是 write → 基线 = 空串 → 整篇
 *   显示为新增，与卡片 A 徽标一致）。
 *
 * 规范化：BOM 去除 + CRLF/CR → LF（edit 匹配语义与 pi-edit 工具一致：
 * 它在 LF 规范化文本上做替换后按原行尾写回，oldText/newText 也是 LF）。
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { getGitExecutable } from "./git-exec.ts";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types.ts";

const execFileAsync = promisify(execFile);

/** 一次对目标文件的已成功完成 mutation。 */
export interface FileMutation {
  kind: "edit" | "write";
  /** edit：调用内的全部替换对（调用顺序）。 */
  edits?: Array<{ oldText: string; newText: string }>;
  /** write：写入的整篇内容（原文，未规范化）。 */
  content?: string;
}

export interface BaselineResult {
  ok: boolean;
  /** 会话开始时的内容（LF 规范化、无 BOM）。仅 ok=true 提供。 */
  baseline?: string;
}

/** 目录条目上的形状（jsonl 原始形状，宽松匹配以兼容历史会话）。 */
type AnyEntry = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 与 session-path/session-reader 相同的绝对路径比较（win 大小写不敏感）。 */
function isSameAbsolutePath(a: string, b: string): boolean {
  try {
    const ra = path.resolve(a);
    const rb = path.resolve(b);
    const same = process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
    return same;
  } catch {
    return false;
  }
}

/** LF 规范化 + 去 BOM，与 pi-edit 的规范步骤一致（不含行尾还原）。 */
function normalizeText(text: string): string {
  let out = text;
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * 取「当前分支」：tip（最后一条）起沿 parentId 回溯到根，再反转。
 * 与 SDK buildSessionPath 同构，但这里要原始 jsonl 形状（含 arguments），
 * 且 getEntries 的返回不带自定义树的便捷方法，单独走一遍。
 * 环与缺失 parent 用 seen 集合防护。
 */
export function collectBranchPath(entries: AnyEntry[]): AnyEntry[] {
  if (entries.length === 0) return [];
  const byId = new Map<string, AnyEntry>();
  for (const e of entries) {
    if (isRecord(e) && typeof e.id === "string") byId.set(e.id, e);
  }
  const leaf = entries[entries.length - 1];
  if (!isRecord(leaf)) return [];
  const chain: AnyEntry[] = [];
  const seen = new Set<string>();
  let current: AnyEntry | undefined = leaf;
  while (current && isRecord(current)) {
    const id = current.id;
    if (typeof id === "string") {
      if (seen.has(id)) break; // parentId 成环：防御，取已收集部分
      seen.add(id);
    }
    chain.push(current);
    const parentId: unknown = current.parentId;
    current = typeof parentId === "string" && parentId ? byId.get(parentId) : undefined;
  }
  if (chain.length > entries.length) return []; // 不可能：防御
  return chain.reverse();
}

/**
 * 从当前分支中收集对 targetAbsPath 的成功 mutation（调用顺序）。
 * - 落盘时序：assistant 块先于其 toolResult append。结果未到（执行中）
 *   的调用计入 —— 它是本会话进行时的真实施加中；若随后失败，其
 *   toolResult 带 isError，下扫到时统一剔除（失败的调用从未成功落盘）。
 * - 路径为相对时按 sessionCwd 解析（工具运行时的 cwd）。
 * - 兼容历史形状：name/arguments 与 toolName/input 双写；edit 的顶层
 *   oldText/newText（legacy 单次替换形状也被落盘过）。
 */
export function collectFileMutations(
  entries: AnyEntry[],
  sessionCwd: string,
  targetAbsPath: string,
): FileMutation[] {
  const branch = collectBranchPath(entries);
  // callId → 有序表下标；failIds 是已判失败的 callId（防重试覆盖）
  const slotById = new Map<string, number>();
  const failIds = new Set<string>();
  const ordered: Array<FileMutation | null> = [];

  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message)) continue;

    if (message.role === "assistant") {
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const toolName = typeof block.toolName === "string" ? block.toolName
          : typeof block.name === "string" ? block.name : "";
        if (toolName !== "edit" && toolName !== "write") continue;
        const rawArgs = isRecord(block.input) ? block.input
          : isRecord(block.arguments) ? block.arguments : null;
        if (!rawArgs) continue;
        const toolPath = typeof rawArgs.path === "string" ? rawArgs.path
          : typeof rawArgs.filePath === "string" ? rawArgs.filePath : null;
        if (!toolPath) continue;
        const abs = path.isAbsolute(toolPath) ? toolPath : path.join(sessionCwd, toolPath);
        if (!isSameAbsolutePath(abs, targetAbsPath)) continue;

        let mutation: FileMutation | null = null;
        if (toolName === "write") {
          if (typeof rawArgs.content === "string") mutation = { kind: "write", content: rawArgs.content };
        } else {
          const edits: Array<{ oldText: string; newText: string }> = [];
          const rawEdits = rawArgs.edits;
          if (Array.isArray(rawEdits)) {
            for (const e of rawEdits) {
              if (isRecord(e) && typeof e.oldText === "string" && typeof e.newText === "string") {
                edits.push({ oldText: e.oldText, newText: e.newText });
              }
            }
          }
          // legacy 单次替换形状：顶层 oldText/newText
          if (edits.length === 0 && typeof rawArgs.oldText === "string" && typeof rawArgs.newText === "string") {
            edits.push({ oldText: rawArgs.oldText, newText: rawArgs.newText });
          }
          if (edits.length > 0) mutation = { kind: "edit", edits };
        }
        if (!mutation) continue;
        const callId = typeof block.toolCallId === "string" ? block.toolCallId
          : typeof block.id === "string" ? block.id : "";
        if (!callId) continue;
        const existing = slotById.get(callId);
        if (existing !== undefined) {
          // 同一 callId 再次出现（重试/重建消息）：覆盖旧槽位
          ordered[existing] = mutation;
          failIds.delete(callId);
        } else {
          slotById.set(callId, ordered.length);
          failIds.delete(callId);
          ordered.push(mutation);
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      if (callId && (message.isError === true || typeof message.error === "string")) {
        const slot = slotById.get(callId);
        if (slot !== undefined) {
          ordered[slot] = null; // 从未成功落盘
          failIds.add(callId);
        }
      }
    }
  }

  return ordered.filter((m): m is FileMutation => m !== null);
}

/**
 * 倒序撤销，重建基线。currentNormalized：磁盘当前内容（LF 规范化、无 BOM）。
 * 匹配失败（bash 漂移 / 文本不一致）返回 { ok:false }，调用方降级为无 diff。
 */
export function computeBaseline(mutations: FileMigrationInput, currentNormalized: string): BaselineResult {
  const list = mutations;
  if (list.length === 0) return { ok: false };
  let state = currentNormalized;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.kind === "write") {
      // 基线截断在 write：write 之前的更早历史不可回退。首 write 同理
      // （新建文件的首次落笔即为基线；后续迭代都成 diff —— 比整篇全绿
      // 更如实，A 徽标语义由卡片 kind 承担）。
      return { ok: true, baseline: normalizeText(typeof m.content === "string" ? m.content : "") };
    }
    const edits = m.edits ?? [];
    // 同一调用内的多条替换在原文件上匹配、不重叠。撤销时倒序处理保证
    // 多处替换互不干扰；newText 必须在当前状态中恰好出现一次。
    let failed = false;
    for (let j = edits.length - 1; j >= 0; j--) {
      const { oldText, newText } = edits[j];
      const nOld = normalizeText(oldText);
      const nNew = normalizeText(newText);
      if (newText === "") {
        // 删除式替换（newText 为空 = 删掉 oldText）：newText 在任何内容里
        // “出现一次”恒假，改为定位 oldText 撤销。
        if (countOccurrences(state, nOld) !== 1) { failed = true; break; }
        state = state.replace(nOld, nNew);
        continue;
      }
      const hits = countOccurrences(state, nNew);
      if (hits !== 1) { failed = true; break; }
      state = state.replace(nNew, nOld);
    }
    if (failed) return { ok: false };
  }
  return { ok: true, baseline: state };
}

/** computeBaseline 的输入类型（数组方向：调用顺序，先到后）。 */
export type FileMigrationInput = FileMutation[];

/** 当前盘上内容是否可作为重构输入（存在、常规文件、≤256KB、无 NUL）。 */
export function canUseDiskContent(absPath: string, buffer: Buffer): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (stat.size > TEXT_PREVIEW_MAX_BYTES) return false;
  return !buffer.includes(0);
}

/**
 * 用 `git diff --no-index` 生成 unified patch（无需 git 仓库；git 仅作为
 * 本地 diff 引擎）。返回 null = 二进制一致或失败。
 */
export async function generateNoIndexPatch(
  oldText: string,
  newText: string,
): Promise<string | null> {
  if (oldText === newText) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diff-"));
  try {
    const aPath = path.join(tmpDir, "a");
    const bPath = path.join(tmpDir, "b");
    fs.writeFileSync(aPath, oldText, "utf8");
    fs.writeFileSync(bPath, newText, "utf8");
    try {
      const { stdout } = await execFileAsync(getGitExecutable(), [
        "-C", tmpDir,
        "diff",
        "--no-index",
        "--no-color",
        "--text",
        "--unified=3",
        "--",
        "a", "b",
      ], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      return stdout === "" ? null : stdout;
    } catch (error) {
      // diff --no-index 有差异时退出码为 1，stdout 带 patch。
      const err = error as { code?: number; stdout?: string };
      if (err && typeof err.code === "number" && err.code === 1 && typeof err.stdout === "string") {
        return err.stdout === "" ? null : err.stdout;
      }
      return null;
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
