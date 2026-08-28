/**
 * 团队黑板 + 文件接触账本（双层上下文共享的文件层）。
 *
 * 背景：多角色各自持有独立 LLM 会话（并行执行/角色边界/窗口预算三重约束下的取舍），
 * 跨角色只传窄带摘要（recent 4 条 × 160 字符 + 上棒总结 1600 字符），导致下棒角色
 * 重复盲目探索同一批文件（token 翻倍的主因）。本模块把「共享面」从对话层搬到文件层：
 *
 *  - L1 自动（零 LLM 依赖）：executor 采集每角色 read/grep/find 接触过的文件 + 实际
 *    改动的文件，落盘 touched/<agentId>.json；下棒角色的上下文注入「上棒接触清单」，
 *    直接从这些文件读起，跳过重复探索。
 *  - L2 主动（结构化）：team_note_write/read/list 受控工具 + notes/<key>.md 文件化
 *    共享笔记——关键发现/接口约定无损传递（替代 160 字符截断），索引注入上下文、
 *    全文按需读取，体量可控。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { getTeamDir } from "./store.ts";

const MAX_NOTE_KEY_LENGTH = 64;
const MAX_TOUCHED_FILES = 40;

function runDir(sessionId: string, runId: string): string {
  return join(getTeamDir(sessionId), "runs", runId);
}

/** 归一化笔记 key：小写、空白/下划线转连字符、只留安全字符。 */
export function normalizeNoteKey(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9\u4e00-\u9fa5-]/g, "").slice(0, MAX_NOTE_KEY_LENGTH);
  return key.replace(/^-+|-+$/g, "");
}

function notesDir(sessionId: string, runId: string): string {
  return join(runDir(sessionId, runId), "notes");
}

export interface BlackboardNote {
  key: string;
  author: string;
  updatedAt: string;
  size: number;
  summary: string;
}

function noteSummary(content: string): string {
  const first = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

/** 写入/覆盖一条黑板笔记（同 key 覆盖，作者与时间记在文件头）。 */
export function writeNote(sessionId: string, runId: string, rawKey: string, content: string, author: string): { key: string } {
  const key = normalizeNoteKey(rawKey);
  if (!key) throw new Error("笔记 key 不能为空（用主题名，如 api-conventions）");
  const dir = notesDir(sessionId, runId);
  mkdirSync(dir, { recursive: true });
  const header = `<!-- author:${author} | updatedAt:${new Date().toISOString()} -->\n`;
  writeFileSync(join(dir, `${key}.md`), header + content, "utf8");
  return { key };
}

/** 读取一条笔记（含元信息）。不存在返回 null。 */
export function readNote(sessionId: string, runId: string, rawKey: string): { key: string; author: string; updatedAt: string; content: string } | null {
  const key = normalizeNoteKey(rawKey);
  if (!key) return null;
  const file = join(notesDir(sessionId, runId), `${key}.md`);
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

/** 列出本 run 的全部笔记索引（按更新时间倒序）。 */
export function listNotes(sessionId: string, runId: string): BlackboardNote[] {
  const dir = notesDir(sessionId, runId);
  if (!existsSync(dir)) return [];
  const out: BlackboardNote[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const full = join(dir, f);
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      const note = readNote(sessionId, runId, f.slice(0, -3));
      if (!note) continue;
      out.push({ key: note.key, author: note.author, updatedAt: note.updatedAt, size, summary: noteSummary(note.content) });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/* ────────────────────────── L1：文件接触账本 ────────────────────────── */

export interface TouchedRecord {
  agentId: string;
  /** 实际改动的文件（正斜杠、cwd 相对或绝对——与 changedFiles 同格式） */
  changedFiles: string[];
  /** 细读/检索过的文件（read/grep/find），按最后接触顺序、去重、限量 */
  readFiles: string[];
  updatedAt: string;
}

function touchedDir(sessionId: string, runId: string): string {
  return join(runDir(sessionId, runId), "touched");
}

function touchedPath(sessionId: string, runId: string, agentId: string): string {
  return join(touchedDir(sessionId, runId), `${agentId}.json`);
}

/**
 * 记录/合并一个角色的文件接触账本（同角色多次执行累积：旧记录在前、新接触在后、
 * 去重并保留每个路径最后一次出现的顺序，总量封顶 MAX_TOUCHED_FILES）。
 */
export function recordTouchedFiles(
  sessionId: string,
  runId: string,
  agentId: string,
  delta: { changedFiles?: string[]; readFiles?: string[] },
): void {
  const prev: TouchedRecord = readTouchedFiles(sessionId, runId, agentId) ?? {
    agentId, changedFiles: [], readFiles: [], updatedAt: "",
  };
  const merge = (oldList: string[], add: string[] | undefined): string[] => {
    if (!add?.length) return oldList;
    const seen = new Set<string>();
    const merged = [...oldList, ...add.map((p) => p.replace(/\\/g, "/"))]
      .filter((p) => {
        if (!p || seen.has(p)) return false;
        seen.add(p);
        return true;
      });
    return merged.slice(-MAX_TOUCHED_FILES); // 保留最近接触
  };
  const record: TouchedRecord = {
    agentId,
    changedFiles: merge(prev.changedFiles, delta.changedFiles),
    readFiles: merge(prev.readFiles, delta.readFiles),
    updatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(touchedDir(sessionId, runId), { recursive: true });
    writeFileSync(touchedPath(sessionId, runId, agentId), JSON.stringify(record, null, 2), "utf8");
  } catch {
    /* 账本写失败不影响主流程 —— 退化为无接触清单注入 */
  }
}

/** 读某角色的接触账本；不存在/损坏返回 null。 */
export function readTouchedFiles(sessionId: string, runId: string, agentId: string): TouchedRecord | null {
  const file = touchedPath(sessionId, runId, agentId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as TouchedRecord;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.readFiles)) return parsed;
  } catch {
    /* fallthrough */
  }
  return null;
}

/** 最近接触过的其他角色账本（排除自己，按更新时间倒序取前 N）。 */
export function recentOtherTouched(sessionId: string, runId: string, currentAgentId: string, limit = 2): TouchedRecord[] {
  const dir = touchedDir(sessionId, runId);
  if (!existsSync(dir)) return [];
  const out: TouchedRecord[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const rec = readTouchedFiles(sessionId, runId, f.slice(0, -5));
      if (rec && rec.agentId !== currentAgentId) out.push(rec);
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit);
}
