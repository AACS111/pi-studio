import type { AssistantContentBlock, ToolCallContent } from "./types";

/**
 * Files explicitly edited/written during an assistant turn.
 * `kind` maps to the tool that produced the change: edit → modified (M),
 * write → added (A). The actual git status may differ (e.g. a written file
 * that was later edited again); the FileViewer's diff view shows the truth.
 */
export interface ChangedFile {
  filePath: string;
  kind: "edit" | "write";
}

const EDIT_TOOL_NAMES = new Set(["edit"]);
const WRITE_TOOL_NAMES = new Set(["write", "write_file", "create", "create_file"]);

function normalizeToolPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  // Reject traversal outside the working tree. Absolute paths are kept as-is
  // (they can still be inside an allowed root); the file API enforces the
  // real allow-list when the file is actually opened.
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

/**
 * True when `filePath` sits inside `cwd` (or equals it). Windows drive letters
 * are compared case-insensitively; separators are normalized first. Used to
 * hide scratch files (temp scripts, exports in system temp, other folders)
 * from the changed-files / generated-files cards — only project files count.
 */
export function isFilePathInsideCwd(filePath: string, cwd: string): boolean {
  const normalizedFile = normalizeToolPath(filePath);
  const normalizedCwd = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedFile || !normalizedCwd) return false;
  // Relative tool paths are resolved against the session cwd by the agent
  // runtime — they are project files by definition.
  const isAbsolute = normalizedFile.startsWith("/") || /^[a-zA-Z]:\//.test(normalizedFile);
  if (!isAbsolute) return true;
  const isWin = /^[a-zA-Z]:\//.test(normalizedFile) || /^[a-zA-Z]:\//.test(normalizedCwd);
  const file = isWin ? normalizedFile.toLowerCase() : normalizedFile;
  const root = isWin ? normalizedCwd.toLowerCase() : normalizedCwd;
  return file === root || file.startsWith(root + "/");
}

function extractFiles(blocks: AssistantContentBlock[] | undefined | null, cwd?: string): ChangedFile[] {
  if (!blocks || blocks.length === 0) return [];

  const seen = new Set<string>();
  const result: ChangedFile[] = [];

  for (const block of blocks) {
    if (block.type !== "toolCall") continue;
    const tc = block as ToolCallContent;
    const toolName = tc.toolName ?? "";
    const kind: ChangedFile["kind"] | null =
      EDIT_TOOL_NAMES.has(toolName) ? "edit"
      : WRITE_TOOL_NAMES.has(toolName) ? "write"
      : null;
    if (!kind) continue;

    const filePath = normalizeToolPath(tc.input?.path ?? tc.input?.filePath);
    if (!filePath || seen.has(filePath)) continue;
    // Only project files are surfaced — temp/scratch files written outside
    // the session cwd (e.g. univer execute scripts) are never shown.
    if (cwd && !isFilePathInsideCwd(filePath, cwd)) continue;
    seen.add(filePath);
    result.push({ filePath, kind });
  }

  return result;
}

/**
 * Extract the list of files this assistant message edited or wrote, in order
 * of first appearance, deduplicated. Only explicit file-mutation tools count
 * (edit/write) — files changed indirectly via `bash` are not attributed to a
 * path here, matching what WorkBuddy/Codex-style UIs surface.
 *
 * When `cwd` is provided, files outside the project directory are filtered
 * out (temp scripts, system-temp exports, other folders never count).
 */
/** 提取缓存：blocks 引用 → cwd → 结果（WeakMap 随 blocks 被 GC 自动清）。 */
const extractCache = new WeakMap<AssistantContentBlock[], Map<string, ChangedFile[]>>();

export function extractChangedFiles(
  blocks: AssistantContentBlock[] | undefined | null,
  cwd?: string,
): ChangedFile[] {
  // 缓存：ChatWindow 渲染循环对同一 message 的 blocks 每帧调用（流式期间每 token
  // 一帧），extractFiles 是全块遍历解析，是长会话卡顿热点之一。同一 blocks 引用
  //（React 数据流不可变约定）+ 同 cwd 直接命中；引用被 GC 后自动清（无膨胀）。
  if (blocks) {
    let byCwd = extractCache.get(blocks);
    if (!byCwd) {
      byCwd = new Map();
      extractCache.set(blocks, byCwd);
    }
    const key = cwd ?? "";
    const hit = byCwd.get(key);
    if (hit) return hit;
    const result = extractFiles(blocks, cwd);
    byCwd.set(key, result);
    return result;
  }
  return extractFiles(blocks, cwd);
}

