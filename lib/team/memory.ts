/**
 * 跨 run 记忆（P2：团队级长期记忆层）。
 *
 * 背景：黑板笔记/文件接触账本都按 run 隔离（runs/<runId>/notes|touched），每次发布新任务
 * 都从零开始——同一团队反复踩同样的坑、重复探索同一批文件。本模块把「值得留下的东西」
 * 沉淀到团队级目录（<teamDir>/memory/），供后续 run 的上下文注入与工具读取：
 *
 *  - 运行回顾（memory/runs/<runId>.md）：run 收尾时自动落盘——任务、结局、统计、
 *    各任务结果、关键决策、产物。下次运行注入「最近运行回顾」索引，让 planner/角色
 *    知道上次做了什么、哪些方案失败了。
 *  - 长期黑板笔记（memory/notes/<key>.md）：run 收尾时把本 run 的黑板笔记晋升合并到
 *    团队级（同 key 取更新者）；后续 run 的 team_note_read/list 可跨 run 回退读取。
 *
 * 全部写操作吞错（记忆是增强层，绝不影响 run 主流程）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { getTeamDir } from "./store.ts";
import { normalizeNoteKey, readNote } from "./blackboard.ts";
import type { ArtifactRef, Decision, TeamRun, TeamTask } from "./types.ts";

const MAX_MEMORY_RUNS = 24;   // 运行回顾留存上限（超出删最旧）
const MAX_MEMORY_NOTES = 64;  // 长期笔记留存上限

function teamMemoryDir(sessionId: string): string {
  return join(getTeamDir(sessionId), "memory");
}

function memoryRunsDir(sessionId: string): string {
  return join(teamMemoryDir(sessionId), "runs");
}

function memoryNotesDir(sessionId: string): string {
  return join(teamMemoryDir(sessionId), "notes");
}

/** ==================== 运行回顾 ==================== */

export interface RunRecapMeta {
  runId: string;
  task: string;
  status: string;
  createdAt: number;
  endedAt: number;
  tokensUsed: number;
  agentExecutions: number;
}

export interface RunRecapIndexEntry extends RunRecapMeta {
  summary: string;
}

/** 回顾文件头（JSON 元信息，机器解析用） */
function recapHeader(meta: RunRecapMeta): string {
  return `<!-- ${JSON.stringify(meta)} -->\n`;
}

function parseRecapHeader(raw: string): RunRecapMeta | null {
  const m = /^<!-- (.+?) -->/.exec(raw);
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]) as RunRecapMeta;
    if (meta && typeof meta.runId === "string" && typeof meta.status === "string") return meta;
  } catch { /* fallthrough */ }
  return null;
}

/** 生成回顾正文（纯函数，测试友好） */
export function buildRunRecapMarkdown(input: {
  meta: RunRecapMeta;
  stopReason?: { code: string; message: string };
  tasks: TeamTask[];
  decisions: Decision[];
  artifacts: ArtifactRef[];
  outputSnippet?: string;
}): string {
  const { meta, stopReason, tasks, decisions, artifacts } = input;
  const lines: string[] = [];
  lines.push("# 运行回顾");
  lines.push("");
  lines.push(`- 任务：${meta.task}`);
  lines.push(`- 结局：${meta.status}${stopReason ? `（${stopReason.code} — ${stopReason.message}）` : ""}`);
  lines.push(`- 统计：角色执行 ${meta.agentExecutions} 次 · ${meta.tokensUsed.toLocaleString("zh-CN")} tokens · ${Math.round((meta.endedAt - meta.createdAt) / 1000)}s`);
  // 任务结果（含 DAG 依赖与失败原因——下次规划的最重要参考）
  const subtasks = tasks.filter((t) => t.id !== "TASK-001" || t.createdBy !== "runtime" || tasks.length === 1);
  if (subtasks.length > 0) {
    lines.push("", "## 任务结果");
    for (const t of subtasks) {
      const mark = t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : t.status === "cancelled" ? "⏹️" : "▫️";
      const dep = t.dependsOn?.length ? `（←${t.dependsOn.join(",")}）` : "";
      const desc = t.description ? `：${t.description.replace(/\n+/g, " ").slice(0, 200)}` : "";
      lines.push(`- ${mark} ${t.id}[${t.assignedAgentId}]「${t.title}」${dep}${t.status === "failed" ? ` — ${t.description?.slice(0, 200) ?? "失败"}` : desc}`);
    }
  }
  if (decisions.length > 0) {
    lines.push("", "## 关键决策");
    for (const d of decisions.slice(-10)) {
      const verdict = d.verdict ? `【${d.verdict === "pass" ? "通过" : d.verdict === "fail" ? "失败" : "参考"}】` : "";
      lines.push(`- [${d.madeBy}] ${d.content.replace(/\n+/g, " ").slice(0, 200)}${verdict}`);
    }
  }
  if (artifacts.length > 0) {
    lines.push("", "## 产物");
    for (const a of artifacts.slice(-10)) lines.push(`- ${a.path}（${a.type}）`);
  }
  return lines.join("\n") + "\n";
}

/** run 收尾时写入运行回顾（覆盖写；吞错） */
export function writeRunRecap(sessionId: string, input: {
  runId: string;
  run: TeamRun;
  stopReason?: { code: string; message: string };
  tasks: TeamTask[];
  decisions: Decision[];
  artifacts: ArtifactRef[];
}): void {
  try {
    const meta: RunRecapMeta = {
      runId: input.runId,
      task: input.run.task,
      status: input.run.status,
      createdAt: input.run.createdAt,
      endedAt: Date.now(),
      tokensUsed: input.run.stats.tokensUsed,
      agentExecutions: input.run.stats.agentExecutions,
    };
    const dir = memoryRunsDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const body = buildRunRecapMarkdown({
      meta,
      stopReason: input.stopReason,
      tasks: input.tasks,
      decisions: input.decisions,
      artifacts: input.artifacts,
    });
    writeFileSync(join(dir, `${input.runId}.md`), recapHeader(meta) + body, "utf8");
    enforceRunCap(sessionId);
  } catch { /* 记忆是增强层，写失败静默 */ }
}

/** 留存上限：超出删除最旧的回顾 */
function enforceRunCap(sessionId: string): void {
  const entries = listRunRecaps(sessionId, Number.MAX_SAFE_INTEGER);
  if (entries.length <= MAX_MEMORY_RUNS) return;
  for (const stale of entries.slice(MAX_MEMORY_RUNS)) {
    try {
      const file = join(memoryRunsDir(sessionId), `${stale.runId}.md`);
      if (existsSync(file)) unlinkSync(file);
    } catch { /* ignore */ }
  }
}

/** 列出运行回顾索引（endedAt 倒序，limit 截取） */
export function listRunRecaps(sessionId: string, limit = 8): RunRecapIndexEntry[] {
  const dir = memoryRunsDir(sessionId);
  if (!existsSync(dir)) return [];
  const out: RunRecapIndexEntry[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const full = join(dir, f);
      let raw: string;
      try { raw = readFileSync(full, "utf8"); } catch { continue; }
      const meta = parseRecapHeader(raw);
      if (!meta) continue;
      const bodyStart = raw.indexOf("-->") + 3;
      const firstLine = raw.slice(bodyStart).split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith("#")) ?? "";
      out.push({ ...meta, summary: firstLine.replace(/^- /, "").slice(0, 120) });
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => b.endedAt - a.endedAt).slice(0, limit);
}

/** 读单次运行回顾全文；不存在返回 null */
export function readRunRecap(sessionId: string, runId: string): string | null {
  const file = join(memoryRunsDir(sessionId), `${runId}.md`);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const idx = raw.indexOf("-->");
    return idx >= 0 ? raw.slice(idx + 3).trimStart() : raw;
  } catch {
    return null;
  }
}

/** ==================== 长期黑板笔记（run 笔记晋升） ==================== */

/** 读团队级长期笔记；不存在返回 null */
export function readMemoryNote(sessionId: string, rawKey: string): { key: string; author: string; updatedAt: string; content: string } | null {
  const key = normalizeNoteKey(rawKey);
  if (!key) return null;
  const file = join(memoryNotesDir(sessionId), `${key}.md`);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const m = /^<!-- author:(.*?) \| updatedAt:(.*?) -->\n?/.exec(raw);
    return {
      key,
      author: m?.[1] ?? "unknown",
      updatedAt: m?.[2] ?? "",
      content: m ? raw.slice(m[0].length) : raw,
    };
  } catch {
    return null;
  }
}

function writeMemoryNote(sessionId: string, key: string, content: string, author: string, updatedAt: string): void {
  const dir = memoryNotesDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const header = `<!-- author:${author} | updatedAt:${updatedAt} -->\n`;
  writeFileSync(join(dir, `${key}.md`), header + content, "utf8");
}

/** 列出长期笔记索引（updatedAt 倒序） */
export function listMemoryNotes(sessionId: string, limit = MAX_MEMORY_NOTES): Array<{ key: string; author: string; updatedAt: string; summary: string }> {
  const dir = memoryNotesDir(sessionId);
  if (!existsSync(dir)) return [];
  const out: Array<{ key: string; author: string; updatedAt: string; summary: string }> = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const note = readMemoryNote(sessionId, f.slice(0, -3));
      if (!note) continue;
      const first = note.content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
      out.push({ key: note.key, author: note.author, updatedAt: note.updatedAt, summary: first.length > 80 ? `${first.slice(0, 80)}…` : first });
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit);
}

/**
 * run 收尾晋升：把本 run 黑板笔记合并进团队级长期笔记。
 * 同 key 冲突时取 updatedAt 更新的一方（run 笔记通常更新；老 run 的旧知识不被新覆盖）。
 * 返回晋升的 key 数（供测试/调试；失败返回 -1）。
 */
export function promoteRunNotes(sessionId: string, runId: string): number {
  try {
    const dir = join(getTeamDir(sessionId), "runs", runId, "notes");
    if (!existsSync(dir)) return 0;
    let promoted = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const key = normalizeNoteKey(f.slice(0, -3));
      if (!key) continue;
      const runNote = readNote(sessionId, runId, key);
      if (!runNote) continue;
      const existing = readMemoryNote(sessionId, key);
      if (!existing || runNote.updatedAt >= existing.updatedAt) {
        writeMemoryNote(sessionId, key, runNote.content, runNote.author, runNote.updatedAt || new Date().toISOString());
        promoted++;
      }
    }
    // 数量上限：超出删最旧
    const all = listMemoryNotes(sessionId, Number.MAX_SAFE_INTEGER);
    if (all.length > MAX_MEMORY_NOTES) {
      for (const stale of all.slice(MAX_MEMORY_NOTES)) {
        try {
          const file = join(memoryNotesDir(sessionId), `${stale.key}.md`);
          if (existsSync(file)) unlinkSync(file);
        } catch { /* ignore */ }
      }
    }
    return promoted;
  } catch {
    return -1;
  }
}
