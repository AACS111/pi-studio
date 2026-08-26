/**
 * 项目组存储层（设计稿 v5 §5）。
 *
 * Event Sourcing 硬约束：
 *  - events.jsonl append-only，是唯一事实来源
 *  - snapshot.json 只是投影缓存（性能优化），可删除重建
 *  - team.json 是静态配置（用户编辑，非事件流）
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "fs";
import { join } from "path";
import { getInternalDir } from "../storage-config.ts";
import { writePrivateFileAtomicSync } from "../atomic-file.ts";
import type { AgentLibraryItem, Projections, TeamDef, TeamEvent, TeamEventInput, TeamSnapshot } from "./types.ts";
import { reduce } from "./types.ts";

/** ==================== 路径 ==================== */

export function getTeamsRoot(): string {
  return join(getInternalDir(), "teams");
}

export function getTeamDir(sessionId: string): string {
  return join(getTeamsRoot(), sessionId);
}

export function getTeamFile(sessionId: string): string {
  return join(getTeamDir(sessionId), "team.json");
}

/** 团队级聊天事件流（转换导入历史 + 非 run 消息） */
export function getChatFile(sessionId: string): string {
  return join(getTeamDir(sessionId), "chat.jsonl");
}

export function getRunsDir(sessionId: string): string {
  return join(getTeamDir(sessionId), "runs");
}

export function getRunDir(sessionId: string, runId: string): string {
  return join(getRunsDir(sessionId), runId);
}

export function getEventsFile(sessionId: string, runId: string): string {
  return join(getRunDir(sessionId, runId), "events.jsonl");
}

export function getSnapshotFile(sessionId: string, runId: string): string {
  return join(getRunDir(sessionId, runId), "snapshot.json");
}

/** ==================== EventStore ==================== */

const SNAPSHOT_EVERY_N_EVENTS = 50;

export class EventStore {
  private readonly sessionId: string;
  private readonly runId: string;
  private readonly eventsFile: string;
  private readonly snapshotFile: string;

  constructor(sessionId: string, runId: string) {
    this.sessionId = sessionId;
    this.runId = runId;
    this.eventsFile = getEventsFile(sessionId, runId);
    this.snapshotFile = getSnapshotFile(sessionId, runId);
  }

  /**
   * 追加一个事件。sequence / timestamp 由 store 分配（单调递增，不依赖客户端）。
   * 单写者串行调用（Runtime 内同一 run 只有一个 EventStore 写路径）。
   * 返回带完整 sequence/timestamp 的事件。
   */
  append(event: TeamEventInput): TeamEvent {
    const sequence = this.nextSequence();
    const full: TeamEvent = {
      ...(event as object),
      sequence,
      timestamp: Date.now(),
    } as TeamEvent;
    mkdirSync(this.eventsFile.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    appendFileSync(this.eventsFile, JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  /** 当前最大 sequence + 1（不存在文件或为空时从 1 开始） */
  nextSequence(): number {
    if (!existsSync(this.eventsFile)) return 1;
    try {
      const content = readFileSync(this.eventsFile, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) return 1;
      const last = lines[lines.length - 1];
      const parsed = JSON.parse(last) as { sequence?: number };
      return (parsed.sequence ?? 0) + 1;
    } catch {
      return 1;
    }
  }

  /** 重放全部事件（保持 append 顺序 = sequence 顺序） */
  replay(): TeamEvent[] {
    if (!existsSync(this.eventsFile)) return [];
    try {
      return readFileSync(this.eventsFile, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as TeamEvent);
    } catch {
      return [];
    }
  }

  /** 读 snapshot（不存在返回 null） */
  loadSnapshot(): TeamSnapshot | null {
    if (!existsSync(this.snapshotFile)) return null;
    try {
      return JSON.parse(readFileSync(this.snapshotFile, "utf8")) as TeamSnapshot;
    } catch {
      return null;
    }
  }

  /** 从 snapshot + 增量 events 重建投影（崩溃恢复/打开 run 时调用） */
  rebuildProjections(): { projections: Projections; eventSequence: number } {
    const snapshot = this.loadSnapshot();
    if (snapshot) {
      const after = this.replay().filter((e) => e.sequence > snapshot.eventSequence);
      const merged = reduce(after);
      const projections: Projections = {
        state: {
          ...snapshot.projections.state,
          decisions: [...snapshot.projections.state.decisions, ...merged.state.decisions],
          artifacts: [...snapshot.projections.state.artifacts, ...merged.state.artifacts],
          completedTasks: [...snapshot.projections.state.completedTasks, ...merged.state.completedTasks],
          activeTasks: [...snapshot.projections.state.activeTasks, ...merged.state.activeTasks],
          blockers: [...snapshot.projections.state.blockers, ...merged.state.blockers],
          lastHandoff: merged.state.lastHandoff ?? snapshot.projections.state.lastHandoff,
          goal: snapshot.projections.state.goal || merged.state.goal,
          phase: merged.state.phase ?? snapshot.projections.state.phase,
        },
        messages: [...snapshot.projections.messages, ...merged.messages],
        tasks: [...snapshot.projections.tasks, ...merged.tasks],
        executions: [...snapshot.projections.executions, ...merged.executions],
        artifacts: [...snapshot.projections.artifacts, ...merged.artifacts],
      };
      return { projections, eventSequence: this.nextSequence() - 1 };
    }
    const projections = reduce(this.replay());
    return { projections, eventSequence: this.nextSequence() - 1 };
  }

  /** 周期性快照（性能优化；写原子文件避免半写状态） */
  saveSnapshot(projections: Projections): void {
    const sequence = this.nextSequence() - 1;
    const snapshot: TeamSnapshot = { eventSequence: sequence, projections };
    writePrivateFileAtomicSync(this.snapshotFile, JSON.stringify(snapshot));
  }

  /** 事件数达到阈值时保存快照（append 后调用） */
  maybeSnapshot(projections: Projections): void {
    const count = this.nextSequence() - 1;
    if (count > 0 && count % SNAPSHOT_EVERY_N_EVENTS === 0) {
      this.saveSnapshot(projections);
    }
  }

  remove(): void {
    try {
      rmSync(getRunDir(this.sessionId, this.runId), { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
}

/** ==================== TeamStore（team.json + index + runs 目录） ==================== */

export interface TeamsIndexEntry {
  teamId: string;             // = sessionId
  name: string;
  createdAt: number;
  uiMode: "team" | "chat";    // "chat" = 转回普通会话（数据保留）
}

export type TeamsIndex = Record<string, TeamsIndexEntry>;

export function getIndexFile(): string {
  return join(getTeamsRoot(), "index.json");
}

/** 用户自建角色库文件（内置角色在 lib/team/library.ts 的 BUILTIN_AGENTS 常量） */
export function getUserLibraryFile(): string {
  return join(getTeamsRoot(), "library.json");
}

export function readUserLibrary(): AgentLibraryItem[] {
  try {
    const file = getUserLibraryFile();
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as AgentLibraryItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeUserLibrary(items: AgentLibraryItem[]): void {
  mkdirSync(getTeamsRoot(), { recursive: true });
  writePrivateFileAtomicSync(getUserLibraryFile(), JSON.stringify(items, null, 2));
}

/** 用户自定义团队模板文件（内置模板在 lib/team/templates.ts 常量；用户模板存数据快照） */
export function getUserTemplatesFile(): string {
  return join(getTeamsRoot(), "user-templates.json");
}

export function readUserTemplates<T>(): T[] {
  try {
    const file = getUserTemplatesFile();
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeUserTemplates<T>(items: T[]): void {
  mkdirSync(getTeamsRoot(), { recursive: true });
  writePrivateFileAtomicSync(getUserTemplatesFile(), JSON.stringify(items, null, 2));
}

/** 读取全部用户模板（server-only；模板类型见 lib/team/templates.ts 的 UserTemplate） */
export function getUserTemplates<T>(): T[] {
  return readUserTemplates<T>();
}

export function readTeamsIndex(): TeamsIndex {
  try {
    const file = getIndexFile();
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8")) as TeamsIndex;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeTeamsIndex(index: TeamsIndex): void {
  mkdirSync(getTeamsRoot(), { recursive: true });
  writePrivateFileAtomicSync(getIndexFile(), JSON.stringify(index, null, 2));
}

export class TeamStore {
  /** 列出全部项目组（含 uiMode） */
  static list(): TeamsIndex {
    return readTeamsIndex();
  }

  /** 读取团队配置；不存在或损坏返回 null */
  static read(sessionId: string): TeamDef | null {
    try {
      const file = getTeamFile(sessionId);
      if (!existsSync(file)) return null;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as TeamDef;
      if (!parsed || parsed.sessionId !== sessionId) return null;
      // 迁移：老团队 maxRunMinutes 落盘了旧默认 30，自动升级到 60 并回写
      // （代码默认值已改 60，但已存在的 team.json 不会自动迁移，否则会反复撞 30 分钟超时）
      if (typeof parsed.maxRunMinutes === "number" && parsed.maxRunMinutes < 60) {
        parsed.maxRunMinutes = 60;
        try { TeamStore.write(parsed); } catch { /* 迁移回写失败不阻断读取 */ }
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** 写团队配置（原子写） */
  static write(team: TeamDef): void {
    mkdirSync(getTeamDir(team.sessionId), { recursive: true });
    writePrivateFileAtomicSync(getTeamFile(team.sessionId), JSON.stringify(team, null, 2));
  }

  /** 注册/更新 index 条目 */
  static upsertIndex(sessionId: string, entry: Partial<TeamsIndexEntry>): void {
    const index = readTeamsIndex();
    const prev = index[sessionId] ?? { teamId: sessionId, createdAt: Date.now(), uiMode: "team" as const };
    index[sessionId] = { ...prev, ...entry };
    writeTeamsIndex(index);
  }

  static removeFromIndex(sessionId: string): void {
    const index = readTeamsIndex();
    delete index[sessionId];
    writeTeamsIndex(index);
  }

  /** 删除整个团队目录（含 runs/events） */
  static remove(sessionId: string): void {
    TeamStore.removeFromIndex(sessionId);
    try {
      rmSync(getTeamDir(sessionId), { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }

  /** 列出该团队的 run id（按目录名） */
  static listRunIds(sessionId: string): string[] {
    const dir = getRunsDir(sessionId);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((n) => existsSync(join(dir, n, "events.jsonl")));
    } catch {
      return [];
    }
  }

  /** 读 run 的 meta（从事件流推导 TeamRun 元数据） */
  static readRunMeta(sessionId: string, runId: string): {
    id: string;
    task: string;
    createdAt: number;
    lastEventAt: number;
    status: string;
    statusReason?: unknown;
    stats: { hopCount: number; reworkCount: number; agentExecutions: number; tokensUsed: number; durationMs: number };
  } | null {
    const events = new EventStore(sessionId, runId).replay();
    if (events.length === 0) return null;
    const first = events[0];
    const last = events[events.length - 1];
    if (first.type !== "run_started") return null;
    const terminal = [...events].reverse().find(
      (e) => e.type === "run_completed" || e.type === "run_failed" || e.type === "run_cancelled",
    );
    const stats = {
      hopCount: events.filter((e) => e.type === "execution_started").length,
      reworkCount: 0, // 由 Runtime 事件补记（Phase 1A 以 execution 计数兜底）
      agentExecutions: events.filter((e) => e.type === "execution_started").length,
      tokensUsed: events.reduce((sum, e) => sum + (e.type === "execution_completed" ? (e.stats?.totalTokens ?? 0) : 0), 0),
      durationMs: last.timestamp - first.timestamp,
    };
    return {
      id: runId,
      task: first.task,
      createdAt: first.timestamp,
      lastEventAt: last.timestamp,
      status: terminal ? terminal.type.replace("run_", "") : "running",
      statusReason: terminal && terminal.type !== "run_completed"
        ? (terminal as { statusReason?: unknown }).statusReason
        : undefined,
      stats,
    };
  }
}
