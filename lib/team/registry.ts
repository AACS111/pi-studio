/**
 * TeamRunRegistry（Step 8 支撑）：管理运行中的 RunManager + 事件广播（SSE）。
 *  - 发布任务 → 创建 RunManager 异步执行（不阻塞 HTTP 响应）
 *  - 订阅者先收全量 replay，再收实时事件
 *  - cancel / steer 入口
 */
import { randomUUID } from "crypto";
import { RunManager } from "./runtime.ts";
import { PiAgentExecutor, type AgentExecutorLike } from "./executor.ts";
import { EventStore, TeamStore } from "./store.ts";
import { classifyTask } from "./task-classify.ts";
import { reduce } from "./types.ts";
import type { TeamDef, TeamEvent, TeamRun } from "./types.ts";

interface RunningEntry {
  manager: RunManager;
  team: TeamDef;
  run: TeamRun;
  listeners: Set<(event: TeamEvent) => void>;
  runListeners: Set<(run: TeamRun) => void>;
}

const registry = new Map<string, RunningEntry>();

export interface StartTeamRunResult {
  runId: string;
}

/** 发布任务并异步执行（返回 runId，执行进度经 SSE 推送）。
 *  startAgentId：可选，指定起始角色（手动指派）；缺省 = 入口角色。
 *  executor：可选注入（测试/自定义执行器）；缺省用真实 PiAgentExecutor。 */
export function startTeamRun(team: TeamDef, task: string, startAgentId?: string, executor?: AgentExecutorLike): StartTeamRunResult {
  const runId = randomUUID().slice(0, 8);
  const complexity = classifyTask(task);
  const run: TeamRun = {
    id: runId,
    teamId: team.sessionId,
    status: "pending",
    task,
    complexity,
    stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const entry: RunningEntry = {
    manager: null as never,
    team,
    run,
    listeners: new Set(),
    runListeners: new Set(),
  };

  entry.manager = new RunManager({
    team,
    runId,
    executor: executor ?? new PiAgentExecutor(),
    onRunUpdate: (r) => {
      entry.run = r;
      for (const cb of entry.runListeners) cb(r);
    },
    onEvent: (e) => {
      for (const cb of entry.listeners) cb(e);
    },
  });
  registry.set(runId, entry);

  void entry.manager
    .execute(run, startAgentId)
    .then((finalRun) => {
      entry.run = finalRun;
      // 执行结束仍保留在 registry 一段时间供查询/重连（不删，重建也可）
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      entry.run = {
        ...entry.run,
        status: "failed",
        statusReason: { code: "agent_failed", message },
        updatedAt: Date.now(),
      };
      for (const cb of entry.runListeners) cb(entry.run);
    });

  return { runId };
}

export function getRunEntry(runId: string): RunningEntry | undefined {
  return registry.get(runId);
}

export function cancelTeamRun(runId: string): boolean {
  const entry = registry.get(runId);
  if (!entry) return false;
  entry.manager.cancel();
  return true;
}

/** P1-2：批准当前等待审批的 transition（LangGraph human-in-loop） */
export function approveTeamRun(runId: string): boolean {
  const entry = registry.get(runId);
  if (!entry) return false;
  return entry.manager.approve();
}

/** P1-2：驳回当前等待审批的 transition */
export function rejectTeamRun(runId: string): boolean {
  const entry = registry.get(runId);
  if (!entry) return false;
  return entry.manager.reject();
}

/** 订阅 run 事件：先重放全量（已落盘），再实时增量 */
export function subscribeTeamRun(
  runId: string,
  onEvent: (event: TeamEvent) => void,
  onRun: (run: TeamRun) => void,
): () => void {
  const entry = registry.get(runId);
  if (!entry) return () => undefined;

  // 1) 重放已落盘事件（含其他进程写入的）
  const store = new EventStore(entry.team.sessionId, runId);
  for (const e of store.replay()) onEvent(e);

  // 2) 当前 run 状态
  onRun(entry.run);

  // 3) 实时订阅（重放与订阅之间的增量由 RunManager onEvent 兜底，重复帧客户端去重）
  entry.listeners.add(onEvent);
  entry.runListeners.add(onRun);
  return () => {
    entry.listeners.delete(onEvent);
    entry.runListeners.delete(onRun);
  };
}

/** steer：人工介入消息（写入 run 事件流，注入下一轮执行上下文） */
export function steerTeamRun(runId: string, content: string, agentId?: string): boolean {
  const entry = registry.get(runId);
  if (!entry) return false;
  const store = new EventStore(entry.team.sessionId, runId);
  store.append({ type: "steer", agentId, content });
  return true;
}

/** 读 run 详情（registry 内存 or 落盘重建） */
export function readRunDetail(sessionId: string, runId: string): {
  run: TeamRun;
  projections: ReturnType<typeof reduce>;
  events: TeamEvent[];
} {
  const entry = registry.get(runId);
  const store = new EventStore(sessionId, runId);
  const events = store.replay();
  const projections = reduce(events);
  let run = entry?.run;
  if (!run) {
    const meta = TeamStore.readRunMeta(sessionId, runId);
    if (meta) {
      run = {
        id: meta.id,
        teamId: sessionId,
        status: meta.status as TeamRun["status"],
        task: meta.task,
        statusReason: meta.statusReason as TeamRun["statusReason"],
        stats: meta.stats,
        createdAt: meta.createdAt,
        updatedAt: meta.lastEventAt,
      };
    } else {
      run = {
        id: runId,
        teamId: sessionId,
        status: "failed",
        task: "",
        stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
  }
  return { run, projections, events };
}
