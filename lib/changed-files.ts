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

// Deliverable-style extensions: spreadsheets, office docs, data exports,
// images, PDFs and archives. Source-code changes stay on the changed-files
// card (with git diff stats); these are the "generated documents" a user
// wants to open in the viewer / Explorer / external app.
const GENERATED_EXTENSIONS = new Set([
  "xlsx", "xls", "univer", "csv", "tsv",
  "docx", "doc", "pptx", "ppt",
  "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico",
  "zip", "rar", "7z", "tar", "gz",
  "md", "html", "htm", "txt", "json",
]);

function getFileExtension(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
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
export function extractChangedFiles(
  blocks: AssistantContentBlock[] | undefined | null,
  cwd?: string,
): ChangedFile[] {
  return extractFiles(blocks, cwd);
}

/**
 * Extract files the assistant turn *generated* as deliverables — `write`-kind
 * tool calls whose path ends in a document/data/image extension (.xlsx,
 * .univer, .csv, .docx, .pdf, .png, .md, …). Source-code edits are excluded
 * (they stay on the changed-files card); the result feeds the generated-files
 * card with open-in-viewer / reveal-in-folder / open-external actions.
 */
export function extractGeneratedFiles(
  blocks: AssistantContentBlock[] | undefined | null,
  cwd?: string,
): ChangedFile[] {
  const all = extractFiles(blocks, cwd);
  return all.filter((file) => file.kind === "write" && GENERATED_EXTENSIONS.has(getFileExtension(file.filePath)));
}
