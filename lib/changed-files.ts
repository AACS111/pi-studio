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

// 变更测试 #2：2026-08-06 通过 edit 工具再改一个文件，验证卡片更新。

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
 * Extract the list of files this assistant message edited or wrote, in order
 * of first appearance, deduplicated. Only explicit file-mutation tools count
 * (edit/write) — files changed indirectly via `bash` are not attributed to a
 * path here, matching what WorkBuddy/Codex-style UIs surface.
 */
export function extractChangedFiles(blocks: AssistantContentBlock[] | undefined | null): ChangedFile[] {
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
    seen.add(filePath);
    result.push({ filePath, kind });
  }

  return result;
}
