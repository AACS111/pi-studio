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
 *
 * P0-3 真并行调度：把「DFS 栈逐个 await」重构为「就绪集 + 波次并发」。
 *  - 每个“波”收集当前所有就绪 Agent，用 Promise.all 并发执行（parallel/inclusive 分叉出的独立分支真正同时跑）。
 *  - 网关（exclusive/inclusive/parallel）先于 Agent 解析；merge 是 AND-join 汇聚点，按入边计数。
 *  - 事件顺序：append 是同步单写者，序列单调；并行分支的 execution_started/completed 严格串行落盘。
 *  - 容错 join：merge 缺分支（exclusive 走了另一路）且整场无其它工作（inflight=0 && ready 空）时容忍推进。
 */
import { EventStore, getTeamDir } from "./store.ts";
import { WorkflowEngine, type LlmJudge, type Route } from "./engine.ts";
import { buildContext } from "./context.ts";
import type { AgentExecutorLike } from "./executor.ts";
import { join } from "path";
import type {
  AgentExecution,
  ApprovalRequest,
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

interface MergeState {
  /** 已到达该 merge 的分支 token（一个 token = 一次独立到达，防重复计数） */
  arrived: Set<string>;
  /** 是否已发布（释放出边回填到执行流） */
  released: boolean;
}

interface Terminal {
  code: RunStopCode;
  message: string;
}

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
  /** P0-fix：用户停止对话 → abort() 下发给正在执行的所有 inflight 会话，让它们立即中止 */
  private readonly controller = new AbortController();
  private agentExecutionCounts = new Map<string, number>();
  private startedAt = 0;
  private approvalResolver?: (approved: boolean) => void;

  // —— P0-3 调度器状态 ——
  private ready: string[] = [];                                      // 就绪节点（Agent 待跑 / 非 merge 网关待解析）
  private inflight = 0;                                              // 当前波次中的 Agent 并发数
  private mergeState = new Map<string, MergeState>();               // merge AND-join 状态
  private gatewaySteps = 0;                                          // 连续网关结构转发计数（防死循环）
  private endReached = false;                                        // 是否已到达 __end__（终结信号）
  private terminal: Terminal | null = null;                          // 终止原因（保险丝/无路由/审批驳回/solo）
  private solo = false;                                              // P0-1 简单任务降级
  private softTimeoutFired = false;                                  // 软超时已触发（允许当前 inflight 波次跑完）
  private lastOutput = "";                                           // 网关 exclusive/inclusive 判定输入
  private lastStatus: ExecutionStatus | "timeout" = "completed";
  private pendingMerges = 0;                                         // 仍在等待分支的 merge 数（用于终态判断）

  constructor(options: RunManagerOptions) {
    this.team = options.team;
    this.runId = options.runId;
    this.executor = options.executor;
    this.workflow = new WorkflowEngine(options.team, options.llmJudge);
    this.store = new EventStore(options.team.sessionId, options.runId);
    this.onRunUpdate = options.onRunUpdate;
    this.onEvent = options.onEvent;
  }

  /** 发布任务并执行（阻塞直至 run 结束；取消用 cancel()）。
   *  startAgentId：可选起始角色（手动指派任务到特定角色）；非法/缺省回退入口角色。 */
  async execute(run: TeamRun, startAgentId?: string): Promise<TeamRun> {
    this.run = { ...run, status: "running", updatedAt: Date.now() };
    this.startedAt = Date.now();
    this.publish();

    const entry = startAgentId && this.team.agents.some((a) => a.id === startAgentId) ? startAgentId : this.team.entryAgentId;

    this.append({ type: "run_started", runId: this.runId, task: this.run.task, entryAgentId: entry, complexity: this.run.complexity });

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

    this.solo = this.shouldSolo(run);

    // 初始化调度器状态
    this.ready = [entry];
    this.inflight = 0;
    this.mergeState = new Map();
    this.gatewaySteps = 0;
    this.endReached = false;
    this.terminal = null;
    this.lastOutput = "";
    this.lastStatus = "completed";

    // 波次泵：直到终止或整场空闲/终态
    await this.pump();

    this.run.updatedAt = Date.now();
    this.run.stats.durationMs = this.run.updatedAt - this.startedAt;
    this.publish();
    this.store.maybeSnapshot(this.store.rebuildProjections().projections);
    return this.run;
  }

  /**
   * 波次泵（P0-3）：每个循环 = 一个“波”。
   *   1) 保险丝检查（cancelled / maxHops / maxRework / timeout）
   *   2) 解析所有就绪网关（可含 llm 判定，await）
   *   3) 收集剩余就绪 Agent，Promise.all 并发执行 → 各自 feed 下一节点
   *   4) 空闲（无 Agent 无网关）→ 尝试容错 release 未达标的 merge；否则终止
   */
  private async pump(): Promise<void> {
    while (!this.terminal) {
      // —— 保险丝 ——
      if (this.cancelled) {
        this.terminal = { code: "user_cancelled", message: "用户取消" };
        break;
      }
      if (this.run.stats.hopCount >= this.team.maxHops) {
        this.terminal = { code: "max_hops", message: `达到最大 Hop 数 ${this.team.maxHops}` };
        break;
      }
      if (this.run.stats.reworkCount > this.team.maxReworkRounds) {
        this.terminal = { code: "max_rework", message: `返工超过上限 ${this.team.maxReworkRounds}` };
        break;
      }
      if (Date.now() - this.startedAt > this.team.maxRunMinutes * 60_000) {
        // 软超时：到点后若仍有 inflight 执行中，允许当前波次跑完再终止（避免在 handoff 缝隙硬切丢产出）
        if (this.inflight > 0 && !this.softTimeoutFired) {
          this.softTimeoutFired = true;
          // 不 break，继续让下方 Promise.all(launchAgent) 跑完当前波次
        } else {
          this.terminal = { code: "timeout", message: `运行超过 ${this.team.maxRunMinutes} 分钟` };
          break;
        }
      }

      // —— 解析所有就绪网关（exclusive/inclusive/parallel）—— merge 不放入 ready，直接 arrive——
      while (true) {
        const gid = this.ready.find((n) => this.isGateway(n));
        if (!gid) break;
        this.ready.splice(this.ready.indexOf(gid), 1);
        await this.processGateway(gid);
        if (this.terminal) break;
      }
      if (this.terminal) break;

      // —— 收集所有就绪 Agent 并同波并发执行 ——
      const agentNodes: string[] = [];
      while (this.ready.length > 0 && !this.isGateway(this.ready[0])) {
        agentNodes.push(this.ready.shift()!);
      }

      if (agentNodes.length === 0 && this.ready.length === 0) {
        // 空闲：若有未达标 merge 等待死分支 → 容错推进；否则整场结束
        if (this.tryTolerantRelease()) continue;
        break;
      }

      this.inflight += agentNodes.length;
      await Promise.all(agentNodes.map((a) => this.launchAgent(a)));
      this.inflight -= agentNodes.length;
    }

    // —— 终态定级（用户取消具有最高优先级，覆盖中途可能的 dead_end/超时） ——
    if (this.cancelled) {
      this.finish("user_cancelled", "用户取消");
    } else if (this.terminal) {
      this.finish(this.terminal.code, this.terminal.message);
    } else if (this.endReached) {
      this.finish("completed", "工作流到达终态");
    } else {
      this.finish("workflow_dead_end", "工作流无可用下一步");
    }
  }

  /** 解析一个网关节点（并行/包容/排他；merge 防御处理出边回填） */
  private async processGateway(nodeId: string): Promise<void> {
    const gateway = this.team.gateways?.find((g) => g.id === nodeId);
    if (!gateway) return;
    if (gateway.type === "merge") {
      // 防御：正常情况下 merge 不会被放进 ready（agent 直接 arrive）。出现则容错推进其出边。
      this.feedMergeOutgoing(gateway.id, "__defensive");
      return;
    }
    this.gatewaySteps++;
    if (this.gatewaySteps > 200) {
      this.terminal = { code: "max_hops", message: "网关结构转发超限（疑似死循环）" };
      return;
    }
    const targets = await this.workflow.resolveGateway(gateway, { status: this.lastStatus, lastOutput: this.lastOutput });
    if (targets.length === 0) {
      this.terminal = { code: "workflow_dead_end", message: `网关「${gateway.name}」无匹配出边` };
      return;
    }
    for (const to of targets) this.ready.push(to);
  }

  /** 执行一个角色（= 一个 pi 会话回合），并把路由后的下一节点 feed 进调度流 */
  private async launchAgent(nodeId: string): Promise<void> {
    this.gatewaySteps = 0; // 有 Agent 执行，网关链计数清零
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
      sessionPath: join(getTeamDir(this.team.sessionId), "sessions", `${this.runId}-${agentId}-${seq}.jsonl`),
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
      mode: this.solo ? "solo" : "orchestrated",
      // 把取消信号传给 executor：用户停止对话时立即 abort 本次会话
      signal: this.controller.signal,
      onEvent: (e) => this.append(e as TeamEventInput),
      onMessage: (m) => this.append({ type: "message_created", message: m as TeamMessage }),
    });

    this.run.stats.hopCount++;
    this.run.stats.agentExecutions++;
    if (result.stats) {
      this.run.stats.tokensUsed += result.stats.totalTokens;
    }
    this.append({
      type: "execution_completed",
      executionId: execution.id,
      status: result.status === "timeout" ? "failed" : result.status,
      failureReason: result.failureReason ?? (result.status === "timeout" ? "执行超时" : undefined),
      ...(result.stats ? { stats: result.stats } : {}),
    });
    this.publish();

    // 记录最近输出/状态（网关 exclusive/inclusive 判定输入）
    this.lastOutput = result.output;
    this.lastStatus = result.status === "timeout" ? "timeout" : result.status;

    // P0-1：solo 降级 — 简单任务只跑入口角色即收尾，不做多角色拆解接力
    if (this.solo) {
      this.terminal = { code: "completed", message: "简单任务由入口角色直接完成" };
      return;
    }

    // —— 路由决策 ——
    const route = await this.workflow.resolveRoute({ agentId, status: result.status }, result, seq);

    // P1-2：人工审批闸门 — 命中 approval 边时暂停等待用户批准/驳回（借鉴 LangGraph human-in-loop）
    if (route && route.transitionId) {
      const transition = this.team.transitions.find((t) => t.id === route.transitionId);
      if (transition?.approval) {
        const req: ApprovalRequest = {
          transitionId: route.transitionId,
          from: route.from,
          to: route.to,
          agentOutput: result.output,
          executionId: execution.id,
          createdAt: Date.now(),
        };
        const approved = await this.waitForApproval(req);
        if (!approved) {
          this.terminal = { code: "user_cancelled", message: "审批被驳回，运行终止" };
          return;
        }
      }
    }

    // —— 返工耗尽收敛（不再硬失败）——
    // 本次是返工边且返工次数已达上限：把动作重定向回入口做一次「收敛总结」，让 run 以
    // best-effort 完成（而非 max_rework 硬失败），如实交付「已达标 + 未达标」清单。
    // 参考 MetaGPT 的「失败重试有上限、超限即收尾交付」思想，避免多 Agent 反复空转。
    const finalRoute: Route | null =
      route &&
      route.to !== END_NODE &&
      route.to !== this.team.entryAgentId &&
      this.isReworkEdge(route) &&
      this.run.stats.reworkCount >= this.team.maxReworkRounds
        ? { kind: "tool", from: route.from, to: this.team.entryAgentId, transitionId: route.transitionId, reason: "返工耗尽，收敛总结" }
        : route;

    if (finalRoute) {
      if (finalRoute.to === END_NODE) {
        this.append({
          type: "handoff_requested",
          executionId: execution.id,
          from: finalRoute.from,
          to: END_NODE,
          kind: finalRoute.kind,
          transitionId: finalRoute.transitionId,
          reason: finalRoute.reason,
        });
        this.publish();
        this.markEndReached();
        return;
      }
      const toMerge = this.isMergeNode(finalRoute.to);
      this.append({
        type: "handoff_requested",
        executionId: execution.id,
        from: finalRoute.from,
        to: finalRoute.to,
        kind: finalRoute.kind,
        transitionId: finalRoute.transitionId,
        reason: finalRoute.reason,
      });
      if (this.isReworkEdge(finalRoute)) this.run.stats.reworkCount++;
      this.publish();
      if (toMerge) {
        this.arriveMerge(finalRoute.to, execution.id);
      } else {
        this.ready.push(finalRoute.to);
      }
      return;
    }

    // —— 无路由 ——
    const mode = this.workflow.effectiveMode(agentId);
    if (mode === "strict") {
      this.terminal = { code: "workflow_dead_end", message: `strict 模式下 ${agentId} 无匹配 Transition` };
      return;
    }
    if (agentId === this.team.entryAgentId) {
      this.terminal = { code: "completed", message: "入口角色收尾完成" };
      return;
    }
    // hybrid 兜底：回入口总结
    this.run.stats.reworkCount++;
    this.append({
      type: "handoff_requested",
      executionId: execution.id,
      from: agentId,
      to: this.team.entryAgentId,
      kind: "tool",
      reason: "hybrid 兜底回入口总结",
    });
    this.publish();
    this.ready.push(this.team.entryAgentId);
  }

  /** 到达 __end__：仅记录，待整场空闲再终结（并行分支需全部到达才算终态） */
  private markEndReached(): void {
    this.endReached = true;
  }

  private isGateway(nodeId: string): boolean {
    return this.team.gateways?.some((g) => g.id === nodeId) ?? false;
  }

  /** P0-fix：abort 所有 inflight 会话（通过 AbortSignal 下发给正在执行的 executor.run） */
  private abortInflight(): void {
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  private isMergeNode(nodeId: string): boolean {
    return this.team.gateways?.some((g) => g.id === nodeId && g.type === "merge") ?? false;
  }

  private mergeInDegree(mergeId: string): number {
    return this.team.transitions.filter((t) => t.to === mergeId && t.enabled !== false).length;
  }

  /** AND-join 到达：入边达到 inDegree（或已释放）则释放出边回填执行流。
   *  可重入（re-armable）：merge 已释放后若再来一个【新 token】（如返工后重进该并行区），
   *  视为新一轮汇聚，重置 arrived 为当前 token、released=false，再按标准释放逻辑处理
   *  （配合 tryTolerantRelease 在空闲时推进，使“返工修复→复验”能从并行区正确回流）。 */
  private arriveMerge(mergeId: string, token: string): void {
    let st = this.mergeState.get(mergeId) ?? { arrived: new Set<string>(), released: false };
    if (st.released) {
      if (st.arrived.has(token)) return;          // 同一轮重复到达，忽略
      // 新 token 且在已释放之后 → 新一轮（返工重进该并行区），重置合并
      st = { arrived: new Set<string>([token]), released: false };
      this.mergeState.set(mergeId, st);
      return;                                     // 未达 inDegree，交由容错/后续分支推进
    }
    if (st.arrived.has(token)) return;            // 同一执行重复到达（防御）
    st.arrived.add(token);
    this.mergeState.set(mergeId, st);
    if (st.arrived.size >= Math.max(this.mergeInDegree(mergeId), 1)) {
      st.released = true;
      this.mergeState.set(mergeId, st);
      this.feedMergeOutgoing(mergeId, token);
    }
  }

  /** 释放 merge 出边（把出边目标 feed 进调度流） */
  private feedMergeOutgoing(mergeId: string, token: string): void {
    void token;
    for (const tr of this.team.transitions) {
      if (tr.from === mergeId && tr.enabled !== false) {
        if (tr.to === END_NODE) {
          this.markEndReached();
        } else if (this.isMergeNode(tr.to)) {
          this.arriveMerge(tr.to, `${mergeId}#${tr.id}`);
        } else {
          this.ready.push(tr.to);
        }
      }
    }
  }

  /** 容错 join：空闲（无 Agent 无网关）且仍有未释放 merge → 视为缺分支（exclusive 走另一路）容忍推进 */
  private tryTolerantRelease(): boolean {
    if (this.inflight !== 0 || this.ready.length !== 0) return false;
    let released = false;
    for (const [mergeId, st] of this.mergeState) {
      if (st.released) continue;
      st.released = true;
      this.mergeState.set(mergeId, st);
      this.feedMergeOutgoing(mergeId, "tolerant");
      released = true;
    }
    return released;
  }

  /** 请求取消（异步：立即 abort 所有 inflight 会话，下次波次循环检查时定终态） */
  cancel(): void {
    this.cancelled = true;
    this.abortInflight();
    this.approvalResolver?.(false);
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

  /** 简单任务 solo 降级判定：complexity=simple 时只跑入口角色，像普通会话直接交付
   *  （发布时已由 classifyTask 判定写入 run.complexity；不再依赖 autoSolo 开关与旧关键词表） */
  private shouldSolo(run: TeamRun): boolean {
    return run.complexity === "simple";
  }

  /** P1-2：等待用户审批（命中 approval 边时暂停）。approve()/reject() 唤醒。 */
  private waitForApproval(req: ApprovalRequest): Promise<boolean> {
    this.run.status = "waiting_approval";
    this.run.pendingApproval = req;
    this.append({
      type: "approval_requested",
      runId: this.runId,
      transitionId: req.transitionId,
      from: req.from,
      to: req.to,
      agentOutput: req.agentOutput,
      executionId: req.executionId,
    });
    this.publish();
    return new Promise<boolean>((resolve) => {
      this.approvalResolver = (approved) => {
        this.append({ type: "approval_resolved", runId: this.runId, transitionId: req.transitionId, approved, by: "user" });
        this.run.pendingApproval = undefined;
        if (approved) this.run.status = "running";
        this.publish();
        resolve(approved);
      };
    });
  }

  /** P1-2：批准当前等待审批的 transition（返回是否有效） */
  approve(): boolean {
    if (!this.approvalResolver) return false;
    this.approvalResolver(true);
    return true;
  }

  /** P1-2：驳回当前等待审批的 transition（返回是否有效） */
  reject(): boolean {
    if (!this.approvalResolver) return false;
    this.approvalResolver(false);
    return true;
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
