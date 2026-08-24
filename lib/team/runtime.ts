/**
 * RunManager（设计稿 v5 §7.4）：run 生命周期 + 执行循环 + 保险丝 + 路由。
 *
 * Event Sourcing：RunManager 是唯一事件写者（EventStore.append）。
 * 每个角色执行前重建投影（snapshot + 增量），构建共享上下文。
 *
 * 保险丝（互不干扰）：
 *  - maxHops：总跳数（任意循环 A→B→C→A）
 *  - maxReworkRounds：返工数（仅返工边 + hybrid 兜底回入口）
 *  - maxRunMinutes：整体超时
 *  - maxTurns：角色级（PiAgentExecutor 内由 pi 会话控制，此处透传）
 */
import { EventStore } from "./store.ts";
import { WorkflowEngine, type LlmJudge, type Route } from "./engine.ts";
import { buildContext } from "./context.ts";
import type { AgentExecutorLike } from "./executor.ts";
import type {
  AgentExecution,
  ExecutionStatus,
  Projections,
  RunStopCode,
  TeamDef,
  TeamEvent,
  TeamEventInput,
  TeamMessage,
  TeamRun,
  TeamTask,
} from "./types.ts";

export const END_NODE = "__end__";

export interface RunManagerOptions {
  team: TeamDef;
  runId: string;
  executor: AgentExecutorLike;
  llmJudge?: LlmJudge;
  /** 每次状态变化回调（SSE 推送用） */
  onRunUpdate?: (run: TeamRun) => void;
  /** 每写一个事件回调（SSE 原始事件用） */
  onEvent?: (event: TeamEvent) => void;
}

export class RunManager {
  private readonly team: TeamDef;
  private readonly runId: string;
  private readonly executor: AgentExecutorLike;
  private readonly workflow: WorkflowEngine;
  private readonly store: EventStore;
  private readonly onRunUpdate?: (run: TeamRun) => void;
  private readonly onEvent?: (event: TeamEvent) => void;

  private run!: TeamRun;
  private cancelled = false;
  private agentExecutionCounts = new Map<string, number>();
  private startedAt = 0;

  constructor(options: RunManagerOptions) {
    this.team = options.team;
    this.runId = options.runId;
    this.executor = options.executor;
    this.workflow = new WorkflowEngine(options.team, options.llmJudge);
    this.store = new EventStore(options.team.sessionId, options.runId);
    this.onRunUpdate = options.onRunUpdate;
    this.onEvent = options.onEvent;
  }

  /** 发布任务并执行（同步阻塞直至 run 结束；取消用 cancel()）。
   *  startAgentId：可选起始角色（手动指派任务到特定角色）；非法/缺省回退入口角色。 */
  async execute(run: TeamRun, startAgentId?: string): Promise<TeamRun> {
    this.run = { ...run, status: "running", updatedAt: Date.now() };
    this.startedAt = Date.now();
    this.publish();

    const entry = startAgentId && this.team.agents.some((a) => a.id === startAgentId) ? startAgentId : this.team.entryAgentId;

    this.append({ type: "run_started", runId: this.runId, task: this.run.task, entryAgentId: entry });

    // 根任务（Runtime 创建，记录"为什么跑这个 run"）
    const rootTask: TeamTask = {
      id: "TASK-001",
      runId: this.runId,
      createdBy: "runtime",
      title: this.run.task,
      description: "用户发布的任务",
      assignedAgentId: entry,
      status: "pending",
      createdAt: Date.now(),
    };
    this.append({ type: "task_created", task: rootTask });

    // 节点栈（DFS）：支持网关分叉/汇聚。agent 节点执行；网关节点做结构化转发。
    const pending: string[] = [entry];
    const mergeArrivals = new Map<string, number>();
    let lastOutput = "";
    let lastStatus: ExecutionStatus | "timeout" = "completed";
    let structuralSteps = 0;

    while (pending.length > 0) {
      // —— 保险丝 ——
      if (this.cancelled) {
        this.finish("user_cancelled", "用户取消");
        break;
      }
      if (this.run.stats.hopCount >= this.team.maxHops) {
        this.finish("max_hops", `达到最大 Hop 数 ${this.team.maxHops}`);
        break;
      }
      if (this.run.stats.reworkCount > this.team.maxReworkRounds) {
        this.finish("max_rework", `返工超过上限 ${this.team.maxReworkRounds}`);
        break;
      }
      if (Date.now() - this.startedAt > this.team.maxRunMinutes * 60_000) {
        this.finish("timeout", `运行超过 ${this.team.maxRunMinutes} 分钟`);
        break;
      }

      const nodeId = pending.pop()!;

      // —— 终态（分支标记）：仅当没有其他活跃分支时整体结束；否则忽略继续跑其他分支 ——
      if (nodeId === END_NODE) {
        if (pending.length === 0) {
          this.finish("completed", "工作流到达终态");
          break;
        }
        continue;
      }

      // —— 网关节点：结构化转发（exclusive 选一条 / parallel 全走 / inclusive 命中全走 / merge 汇聚）——
      const gateway = this.team.gateways?.find((g) => g.id === nodeId);
      if (gateway) {
        if (gateway.type === "merge") {
          // 汇聚：所有入边到达后继续；缺分支（如 exclusive 走了另一路）时容错推进
          const inCount = this.team.transitions.filter((t) => t.to === gateway.id && t.enabled !== false).length;
          const arrived = (mergeArrivals.get(gateway.id) ?? 0) + 1;
          mergeArrivals.set(gateway.id, arrived);
          const ready = arrived >= Math.max(inCount, 1);
          if (ready || pending.length === 0) {
            for (const tr of this.team.transitions) {
              if (tr.from === gateway.id && tr.enabled !== false) pending.push(tr.to);
            }
          }
          continue;
        }
        structuralSteps++;
        if (structuralSteps > 200) {
          this.finish("max_hops", "网关结构转发超限（疑似死循环）");
          break;
        }
        const targets = await this.workflow.resolveGateway(gateway, { status: lastStatus, lastOutput });
        if (targets.length === 0) {
          this.finish("workflow_dead_end", `网关「${gateway.name}」无匹配出边`);
          break;
        }
        for (const to of targets) pending.push(to);
        continue;
      }

      // —— 执行一个角色 ——
      structuralSteps = 0;
      const agentId = nodeId;
      const seq = (this.agentExecutionCounts.get(agentId) ?? 0) + 1;
      this.agentExecutionCounts.set(agentId, seq);
      const execution: AgentExecution = {
        id: `${this.runId}-${agentId}-${seq}`,
        runId: this.runId,
        agentId,
        sequence: seq,
        status: "running",
        startedAt: Date.now(),
        sessionId: `${this.runId}-${agentId}-${seq}`,
      };
      this.append({ type: "execution_started", execution });

      // 重建投影 → 构建共享上下文（快照 + 增量）
      const { projections } = this.store.rebuildProjections();
      const agent = this.team.agents.find((a) => a.id === agentId);
      const context = agent
        ? buildContext({ team: this.team, run: this.run, projections, agent })
        : this.run.task;

      const result = await this.executor.run({
        team: this.team,
        runId: this.runId,
        execution,
        context,
        existingTasks: projections.tasks,
        onEvent: (e) => this.append(e as TeamEventInput),
        onMessage: (m) => this.append({ type: "message_created", message: m as TeamMessage }),
      });

      this.run.stats.hopCount++;
      this.run.stats.agentExecutions++;
      this.append({
        type: "execution_completed",
        executionId: execution.id,
        status: result.status === "timeout" ? "failed" : result.status,
        failureReason: result.failureReason ?? (result.status === "timeout" ? "执行超时" : undefined),
      });
      this.publish();

      // 记录最近输出（网关 exclusive/inclusive 的判定输入）
      lastOutput = result.output;
      lastStatus = result.status === "timeout" ? "timeout" : result.status;

      // —— 路由决策 ——
      const route = await this.workflow.resolveRoute({ agentId, status: result.status }, result);

      if (route && route.to === END_NODE) {
        this.append({ type: "handoff_requested", executionId: execution.id, from: route.from, to: END_NODE, kind: route.kind, transitionId: route.transitionId, reason: route.reason });
        pending.push(END_NODE);
        this.publish();
        continue;
      }

      if (!route) {
        const mode = this.workflow.effectiveMode(agentId);
        if (mode === "strict") {
          this.finish("workflow_dead_end", `strict 模式下 ${agentId} 无匹配 Transition`);
          break;
        }
        if (agentId === this.team.entryAgentId) {
          this.finish("completed", "入口角色收尾完成");
          break;
        }
        // hybrid 兜底：回入口总结
        this.run.stats.reworkCount++;
        this.append({ type: "handoff_requested", executionId: execution.id, from: agentId, to: this.team.entryAgentId, kind: "tool", reason: "hybrid 兜底回入口总结" });
        pending.push(this.team.entryAgentId);
        this.publish();
        continue;
      }

      // 正常流转
      this.append({
        type: "handoff_requested",
        executionId: execution.id,
        from: route.from,
        to: route.to,
        kind: route.kind,
        transitionId: route.transitionId,
        reason: route.reason,
      });
      if (this.isReworkEdge(route)) this.run.stats.reworkCount++;
      pending.push(route.to);
      this.publish();
    }

    this.run.updatedAt = Date.now();
    this.run.stats.durationMs = this.run.updatedAt - this.startedAt;
    this.publish();
    this.store.maybeSnapshot(this.store.rebuildProjections().projections);
    return this.run;
  }

  /** 请求取消（异步：下次循环检查时生效） */
  cancel(): void {
    this.cancelled = true;
  }

  /** 返工边判定：reworkEdges 显式配置优先；兜底启发式（验证类角色→非 entry） */
  private isReworkEdge(route: Route): boolean {
    const explicit = this.team.reworkEdges?.find((e) => e.from === route.from && e.to === route.to);
    if (explicit) return true;
    if (this.team.reworkEdges && this.team.reworkEdges.length > 0) {
      // 配置了返工边集合但当前边不在其中 → 非返工
      return false;
    }
    const from = this.team.agents.find((a) => a.id === route.from);
    return from !== undefined && /测试|QA|审|验证|质检/i.test(from.role) && route.to !== this.team.entryAgentId;
  }

  private finish(code: RunStopCode, message: string): void {
    this.run.status = code === "completed" ? "completed" : code === "user_cancelled" ? "cancelled" : "failed";
    this.run.statusReason = { code, message };
    const evType = code === "completed" ? "run_completed" : code === "user_cancelled" ? "run_cancelled" : "run_failed";
    this.append({ type: evType, statusReason: { code, message } } as TeamEventInput);
    this.publish();
  }

  private append(event: TeamEventInput): void {
    const full = this.store.append(event);
    this.onEvent?.(full);
    // 周期性快照（性能优化）
    if (full.sequence % 50 === 0) {
      const { projections } = this.store.rebuildProjections();
      this.store.saveSnapshot(projections);
    }
  }

  private publish(): void {
    if (this.run) this.onRunUpdate?.(this.run);
  }

  /** 供外部读取当前投影（调试/测试） */
  projections(): Projections {
    return this.store.rebuildProjections().projections;
  }
}
