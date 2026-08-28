/**
 * 项目组生命周期（设计稿 v5 §6）：Team-backed Session。
 *  - Pi Session 负责身份/生命周期/Sidebar
 *  - TeamRuntime 负责群聊/Workflow/Agent 执行
 *  - 转换只切 uiMode（Team 数据保留，方案 A）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  readSessionHeader,
  resolveSessionPath,
} from "../session-reader.ts";
import { sessionPathKey } from "../session-path.ts";
import { TeamStore, getChatFile, EventStore } from "./store.ts";
import { createTeamDef } from "./templates.ts";
import { getUserTemplates } from "./store.ts";
import type { TeamDef, TeamMessage, TeamMessageKind } from "./types.ts";

/** ==================== 群聊事件流（转换历史 + 非 run 消息） ==================== */

/**
 * <sessionId>/chat.jsonl —— 团队级聊天事件流（append-only）。
 * 存放：转换导入的历史消息 + 未来 run 之外的群聊消息。
 * run 执行期间的消息在 runs/<runId>/events.jsonl（执行事件流）。
 * 两者都是事件流（均有 sequence），群聊视图合并投影。
 */
export class TeamChatStore {
  private readonly sessionId: string;
  private readonly file: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.file = getChatFile(sessionId);
  }

  /** 追加一条消息事件（sequence 递增），返回完整消息 */
  appendMessage(message: Omit<TeamMessage, "id" | "createdAt">): TeamMessage {
    const sequence = this.nextSequence();
    const full: TeamMessage = { ...message, id: `chat-${sequence}`, createdAt: Date.now() };
    // 用 EventStore 的文件格式写（每行 { sequence, timestamp, type, message }）
    const line = JSON.stringify({
      sequence,
      timestamp: full.createdAt,
      type: "message_created",
      message: full,
    });
    this.ensureDir();
    appendFileSync(this.file, line + "\n", "utf8");
    return full;
  }

  /** 重放全部聊天消息（按 sequence 顺序） */
  replayMessages(): TeamMessage[] {
    try {
      if (!existsSync(this.file)) return [];
      return readFileSync(this.file, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { sequence: number; message: TeamMessage })
        .sort((a, b) => a.sequence - b.sequence)
        .map((e) => e.message);
    } catch {
      return [];
    }
  }

  private nextSequence(): number {
    if (!existsSync(this.file)) return 1;
    try {
      const lines = readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim());
      if (lines.length === 0) return 1;
      return (JSON.parse(lines[lines.length - 1]) as { sequence: number }).sequence + 1;
    } catch {
      return 1;
    }
  }

  private ensureDir(): void {
    mkdirSync(dirname(this.file), { recursive: true });
  }
}

/** ==================== 生命周期 ==================== */

export interface CreateTeamOptions {
  cwd: string;
  name?: string;
  templateId?: string;
  /** 空团队/自定义模板时选中的角色 id 列表（来自库）。leader 始终自动包含。 */
  agentIds?: string[];
}

export interface CreateTeamResult {
  sessionId: string;
  sessionFile: string;
  team: TeamDef;
}

/** 新建项目组：创建宿主 pi 会话 + 团队配置 + index */
export function createTeam(options: CreateTeamOptions): CreateTeamResult {
  const { cwd, name, templateId } = options;
  const manager = SessionManager.create(cwd, undefined);
  const sessionFile = manager.newSession({});
  if (!sessionFile) throw new Error("Failed to create host session for team");
  const sessionId = manager.getSessionId();
  cacheSessionPath(sessionId, sessionFile);

  const teamName = name?.trim() || "";
  // SDK 惰性落盘：只有出现 assistant 消息才全量写盘，纯空会话永不落盘。
  // 手动写最小合法会话文件（header + session_info），保证 sidebar 可见、可 open。
  // name 为空时：侧边栏/顶部标题回退到首条任务片段（与普通会话一致）。
  const now = new Date().toISOString();
  mkdirSync(dirname(sessionFile), { recursive: true });
  const header = { type: "session", version: 3, id: sessionId, timestamp: now, cwd };
  const infoEntry = {
    type: "session_info",
    id: `info-${sessionId}`,
    parentId: null,
    timestamp: now,
    name: teamName,
  };
  writeFileSync(sessionFile, JSON.stringify(header) + "\n" + JSON.stringify(infoEntry) + "\n", "utf8");

  const team = createTeamDef(sessionId, cwd, teamName, templateId, getUserTemplates(), options.agentIds);
  // 用户真实新建的团队：启用 DAG 编排引擎（先计划后调度，2026-08 重构）。
  // 模板默认不写入——存量团队/测试用例保持旧 transitions 引擎行为。
  team.orchestration = "dag";
  TeamStore.write(team);
  TeamStore.upsertIndex(sessionId, { teamId: sessionId, name: teamName, uiMode: "team" });
  invalidateSessionListCache();
  return { sessionId, sessionFile, team };
}

export interface ConvertTeamOptions {
  sessionId: string;
  name?: string;
  templateId?: string;
  /** 空团队/自定义模板时选中的角色 id 列表 */
  agentIds?: string[];
}

export interface ConvertTeamResult {
  team: TeamDef;
  importedCount: number;
}

/**
 * 已有会话 → 项目组（历史导入为 chat 事件）。
 *  - user 消息 → kind:"user"
 *  - assistant 消息 → kind:"imported"（agentId="__legacy__"，role="原会话"）
 *  - 工具调用/结果、thinking_level_change 等 → 剔除
 *  - 前置 system 消息「以下为转换为项目组前的会话历史」
 */
export async function convertTeam(options: ConvertTeamOptions): Promise<ConvertTeamResult> {
  const { sessionId, name, templateId } = options;

  if (TeamStore.read(sessionId)) {
    throw new Error("Session is already a team");
  }
  const sessionFile = await resolveSessionPath(sessionId);
  if (!sessionFile) throw new Error("Session not found");

  const manager = SessionManager.open(sessionFile, undefined);
  const entries = manager.getBranch();

  const messages: TeamMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue; // 剔除工具/模型切换/压缩等
    const msg = (entry as unknown as { message: { role?: string; content?: unknown; timestamp?: string } }).message;
    const text = extractText(msg.content);
    if (!text) continue;
    const createdAt = msg.timestamp ? Date.parse(msg.timestamp) : Date.now();
    if (msg.role === "user") {
      messages.push({ id: `imp-u-${messages.length}`, kind: "user", content: text, createdAt });
    } else if (msg.role === "assistant") {
      messages.push({
        id: `imp-a-${messages.length}`,
        kind: "agent",
        agentId: "assistant",
        role: "原会话",
        content: text,
        createdAt,
      });
    }
  }

  const chat = new TeamChatStore(sessionId);
  if (messages.length > 0) {
    chat.appendMessage({ kind: "system", content: "以下为转换为项目组前的会话历史（工具调用/附件已省略）" });
  }
  for (const m of messages) {
    chat.appendMessage({ kind: m.kind, agentId: m.agentId, role: m.role, content: m.content });
  }

  const teamName = name?.trim() || "";
  const team = createTeamDef(sessionId, manager.getCwd(), teamName, templateId, getUserTemplates(), options.agentIds);
  TeamStore.write(team);
  TeamStore.upsertIndex(sessionId, { teamId: sessionId, name: teamName, uiMode: "team" });
  invalidateSessionListCache();
  return { team, importedCount: messages.length };
}

/** 切换 UI 模式：转回普通会话（"chat"，数据保留）或恢复项目组（"team"） */
export function setTeamUiMode(sessionId: string, uiMode: "team" | "chat"): void {
  if (!TeamStore.read(sessionId)) throw new Error("Not a team");
  TeamStore.upsertIndex(sessionId, { uiMode });
  invalidateSessionListCache();
}

/**
 * 删除项目组 = 删除宿主 pi 会话（级联重挂子会话）+ 团队数据。
 * 逻辑与 app/api/sessions/[id]/route.ts DELETE 一致，供 /api/teams/:id 复用。
 */
export async function deleteTeam(sessionId: string): Promise<void> {
  const filePath = await resolveSessionPath(sessionId);
  if (filePath) {
    const parentSessionPath = readSessionHeader(filePath)?.parentSession;
    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    try {
      const files = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
          if (
            header.type === "session" &&
            header.parentSession &&
            sessionPathKey(header.parentSession) === targetPathKey
          ) {
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            writeFileSync(childPath, lines.join("\n"));
          }
        } catch {
          /* skip malformed */
        }
      }
    } catch {
      /* skip if dir unreadable */
    }
    await getRpcSessionLazy(sessionId);
    unlinkSync(filePath);
    invalidateSessionPathCache(sessionId);
  }
  TeamStore.remove(sessionId);
  invalidateSessionListCache();
}

/** 懒加载 rpc-manager（避免 lifecycle 顶层依赖 TUI 链，node 测试可独立加载） */
async function getRpcSessionLazy(sessionId: string): Promise<void> {
  try {
    const { getRpcSession } = await import("../rpc-manager.ts");
    await getRpcSession(sessionId)?.shutdown();
  } catch {
    /* rpc-manager 不可用（如纯 node 环境）时跳过 */
  }
}

/** 提取消息文本（string 或 blocks 中的 text） */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n")
      .trim();
  }
  return "";
}

/** 供测试/调试：读团队全部聊天消息 */
export function readTeamChat(sessionId: string): TeamMessage[] {
  return new TeamChatStore(sessionId).replayMessages();
}

/** 供测试/调试：列出团队所有 run 的投影消息 */
export function readRunMessages(sessionId: string, runId: string): TeamMessage[] {
  const events = new EventStore(sessionId, runId).replay();
  return events
    .filter((e) => e.type === "message_created")
    .map((e) => (e as { message: TeamMessage }).message);
}

export type { TeamMessageKind };
