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
import { WorkflowEngine, type ExecutionResult, type LlmJudge, type Route } from "./engine.ts";
import { buildContext, buildTaskContext } from "./context.ts";
import { recordTouchedFiles } from "./blackboard.ts";
import type { AgentExecutorLike } from "./executor.ts";
import { join } from "path";
import type {
  AgentExecution,
  ApprovalRequest,
  ExecutionStatus,
  PlanTask,
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
  /** 取消后强制收敛的兜底等待（毫秒）：executor 对 abort 无响应时也保证 run 停止。默认 3000。 */
  cancelForceMs?: number;
  /** 审批闸门等待超时（毫秒）：超过后仍无响应则按「运行时自动驳回」收敛，避免 run 永久挂在
   *  waiting_approval、绕过所有保险丝（用户离开页面/没看到审批请求时整个团队卡死）。
   *  实际生效值 = min(本值, maxRunMinutes 剩余额度)，双重约束都不可被 waiting 绕过。
   *  默认 30 分钟；Infinity 显式禁用（只能等用户响应或取消）。 */
  approvalTimeoutMs?: number;
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
  private finished = false;                                         // finish 最多执行一次（避免 cancel 兜底与正常路径双重收尾）
  private cancelForceTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelForceMs = 3000;                                      // 取消后 executor 无响应时的强制收敛等待
  /** P0-fix：用户停止对话 → abort() 下发给正在执行的所有 inflight 会话，让它们立即中止 */
  private readonly controller = new AbortController();
  private agentExecutionCounts = new Map<string, number>();
  private startedAt = 0;
  private approvalResolver?: (approved: boolean) => void;
  private approvalTimeoutMs = 30 * 60_000;      // 审批等待超时默认 30 分钟（RunManagerOptions 注入可改）

  // —— P0-3 调度器状态 ——
  private ready: string[] = [];                                      // 就绪节点（Agent 待跑 / 非 merge 网关待解析）
  private inflight = 0;                                              // 当前波次中的 Agent 并发数
  private mergeState = new Map<string, MergeState>();               // merge AND-join 状态
  private gatewaySteps = 0;                                          // 连续网关结构转发计数（防死循环）
  private endReached = false;                                        // 是否已到达 __end__（终结信号）
  private terminal: Terminal | null = null;                          // 终止原因（保险丝/无路由/审批驳回/solo）
  private solo = false;                                              // P0-1 简单任务降级
  private softTimeoutFired = false;                                  // 软超时已触发（允许当前 inflight 波次跑完）
  private lastOutput = "";                                           // 网关 exclusive/inclusive 判定输入（全局兜底）
  private lastStatus: ExecutionStatus | "timeout" = "completed";
  // —— 网关输入汇聚（修并行波次竞态）：并行波次里多个分支都可能 feed 同一网关。
  // 判定输入用「自上次消费以来到达该网关的全部分支输出」聚合值，而非全局共享的
  // lastOutput —— 旧实现在 Promise.all 并发完成时只留最后完成者的输出，且与
  // 「哪个分支到达该网关」无关 → 排他/包容网关可能按错误分支路由走错方向。
  private gatewayInputs = new Map<string, { statuses: Array<ExecutionStatus | "timeout">; outputs: string[] }>();
  private pendingMerges = 0;                                         // 仍在等待分支的 merge 数（用于终态判断）
  private completedAgentIds = new Set<string>();                      // 已成功完成 ≥1 次的下游角色（no-progress 循环守卫用）
  private entryHandoffCounts = new Map<string, number>();             // 入口角色(leader)交接给每个角色的次数（守卫用）
  private static readonly NO_PROGRESS_HANDOFF_THRESHOLD = 2;          // 同一角色被 leader 重复交接 ≥2 次且已成功完成 → 判定无进展循环

  constructor(options: RunManagerOptions) {
    // NaN 保险丝兑底（防御性副本，不动调用方对象）：旧/手写 team.json 缺 maxHops/
    // maxReworkRounds/maxRunMinutes 时，undefined 参与比较恒 false → pump 三条保险丝全部
    // 静默失效；同时 computeExecutionTimeoutMs 返回 NaN → setTimeout(NaN)≈立即超时 →
    // 每次执行瞬间失败 → hybrid 兑底回入口 → 以 CPU 速度无限循环刷盘（run 永不终止）。
    const t = options.team;
    this.team = {
      ...t,
      maxHops: Number.isFinite(t.maxHops) && t.maxHops > 0 ? t.maxHops : 40,
      maxReworkRounds: Number.isFinite(t.maxReworkRounds) && t.maxReworkRounds >= 0 ? t.maxReworkRounds : 3,
      maxRunMinutes: Number.isFinite(t.maxRunMinutes) && t.maxRunMinutes > 0 ? t.maxRunMinutes : 30,
    };
    this.runId = options.runId;
    this.executor = options.executor;
    this.workflow = new WorkflowEngine(options.team, options.llmJudge);
    this.store = new EventStore(options.team.sessionId, options.runId);
    this.onRunUpdate = options.onRunUpdate;
    this.onEvent = options.onEvent;
    if (options.cancelForceMs) this.cancelForceMs = options.cancelForceMs;
    if (options.approvalTimeoutMs !== undefined) this.approvalTimeoutMs = options.approvalTimeoutMs;
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
    this.gatewayInputs.clear();

    // 编排引擎选择（2026-08 重构）：显式 "dag"＝先计划后调度；
    // 未设置/transitions ＝ 旧自由路由引擎（兼容存量团队与 serial/parallel 内置流程）。
    // DAG 计划失败自动回退旧引擎（永不断粮）；solo 与旧模式直接走波次泵。
    const useDag = !this.solo && this.team.orchestration === "dag";
    // 编排层总兑底：泵内未被隔离的异常（事件 append 磁盘错误等）在此收口为 run_failed
    // 落盘事件（finish 幂等），保证重开页面走 replay 不会看到永远 running 的 run。
    // registry 的 .catch 只能改内存 entry.run，落盘必须在这里做。
    try {
      if (useDag) {
        await this.pumpDag(entry);
      }
      if (!useDag || this.dagFallback) {
        if (this.dagFallback) {
          this.dagFallback = false;
          this.resetForLegacyPump();
          this.append({
            type: "message_created",
            message: {
              id: `msg-${this.runId}-dag-fallback`,
              kind: "system",
              role: "",
              content: "⚠️ 自动拆解计划未成功（模型未能提交有效任务计划），已回退到传统工作流引擎继续执行本次任务。",
              createdAt: Date.now(),
            },
          });
        }
        // 波次泵：直到终止或整场空闲/终态
        await this.pump();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finish("agent_failed", `编排异常：${message.slice(0, 300)}`);
      throw error;
    }

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
      // 修复（高危）：网关若存在「入边来源 agent 仍在 ready 等待执行」的边 → 推迟解析（本轮先跑 agent）。
      // 否则 custom 画布「网关→agent→网关」链里，parallel 分叉产出 [A, gw] 且存在 A→gw 边时：
      // gw 会在 A 执行前被消费（gatewayInputs 空 → 回退过期 lastOutput 路由），A 跑完 feed 后
      // gw 被二次消费 → 下游重复执行（先跑错分支再跑对分支，两边都执行）。
      while (true) {
        const consumable = this.ready.find((n) => {
          if (!this.isGateway(n)) return false;
          // 入边来源里若是「还在 ready 队列等跑的 agent」→ 输入未齐，不可消费
          const inbound = (this.team.transitions ?? [])
            .filter((t) => t.to === n && !this.isGateway(t.from))
            .map((t) => t.from);
          return !inbound.some((from) => this.ready.includes(from));
        });
        if (consumable) {
          this.ready.splice(this.ready.indexOf(consumable), 1);
          await this.processGateway(consumable);
          if (this.terminal) break;
          continue;
        }
        // 安全阀：ready 里全是被推迟的网关（无 agent 可跑、无 merge 推进）→ 强制消费第一个，
        // 防止「入边来源永远不会进 ready」的结构导致空转死循环。行为回退到旧版（回退 lastOutput 路由），
        // 但发一条可见警告。
        if (this.ready.length > 0 && this.ready.every((n) => this.isGateway(n))) {
          const forced = this.ready.shift()!;
          this.append({
            type: "message_created",
            message: {
              id: `msg-${this.runId}-gw-force-${forced}`,
              kind: "system",
              role: "",
              content: `⚠️ 网关「${forced}」的入边来源角色均不在本次就绪队列，已强制解析（输入可能不完整）。请检查工作流结构是否存在不可达节点。`,
              createdAt: Date.now(),
            },
          });
          await this.processGateway(forced);
          if (this.terminal) break;
          continue;
        }
        break;
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
      // 修复（中危）：Promise.all → allSettled + 分支异常隔离。launchAgent 内 executor 异常
      // 已在 spawnExecution 闭合，但 append（磁盘错误）/resolveRoute（llmJudge 抛错）/
      // waitForApproval 等编排层异常会击穿 Promise.all → pump 崩溃 → 兄弟分支被遗弃、
      // 事件流无 run_failed 终态（重开页面永远 running）。改为单分支隔离继续。
      const settled = await Promise.allSettled(agentNodes.map((a) => this.launchAgent(a)));
      this.inflight -= agentNodes.length;
      settled.forEach((r, idx) => {
        if (r.status !== "rejected") return;
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        try {
          this.append({
            type: "message_created",
            message: {
              id: `msg-${this.runId}-branch-err-${agentNodes[idx]}`,
              kind: "system",
              role: "",
              agentId: agentNodes[idx],
              content: `⚠️ 角色「${agentNodes[idx]}」分支编排异常，已隔离继续执行其余分支：${message.slice(0, 200)}`,
              createdAt: Date.now(),
            },
          });
        } catch { /* 事件落盘失败（磁盘级）无法补救，交给 execute 外层 catch 兑底 */ }
      });
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

  /** ==================== DAG 编排泵（plan-then-dispatch）====================
   *  借鉴 CrewAI hierarchical / LangGraph supervisor / MetaGPT SOP：
   *  Phase A 计划：入口角色作 planner，用 team_submit_plan 一次性提交任务 DAG
   *            （工具层校验：角色存在/依赖引用/无环/≤12 任务）；失败自动回退旧引擎。
   *  Phase B 调度：按 dependsOn 就绪集波次派发（天然并行、天然终止）；
   *            verdict=fail → 同任务重试（附失败反馈，上限 maxReworkRounds），不扩散到无关角色；
   *            上游交付物结构化注入下游上下文（MetaGPT 式交接，不再灌全量聊天）。
   *  Phase C 收尾：全部完成/部分阻塞 → 入口角色出最终报告。
   *  终止性：|计划任务|×(1+maxReworkRounds)+planner+finisher 次 executions，maxHops 兕底。 */
  private dagFallback = false;

  private async pumpDag(entry: string): Promise<void> {
    const maxRework = Math.max(1, this.team.maxReworkRounds);

    // —— Phase A：计划（首提 + 至多 2 次纠错）——
    let plan: PlanTask[] | null = null;
    let planError: string | null = null; // 上一轮失败原因，纠错轮注入 prompt
    for (let attempt = 0; attempt < 3 && !plan; attempt++) {
      if (this.cancelled) break;
      if (this.run.stats.hopCount >= this.team.maxHops) break;
      const { result } = await this.spawnExecution(entry, {
        planner: true,
        ...(planError ? { planError } : {}),
      });
      if (result.plan) {
        plan = result.plan;
      } else if (this.cancelled) {
        break;
      } else {
        planError = result.planError ?? `执行未成功（${result.status}）`;
        this.append({
          type: "message_created",
          message: {
            id: `msg-${this.runId}-plan-retry-${attempt}`,
            kind: "system",
            role: "",
            content: `⚠️ 计划提交${attempt === 0 ? "缺失" : "被拒"}（${attempt + 1}/3）：${planError.slice(0, 200)}。重新发起计划轮…`,
            createdAt: Date.now(),
          },
        });
      }
    }
    if (!plan || plan.length === 0) {
      this.dagFallback = true;
      return;
    }

    // —— 计划落盘：创建 TeamTask（parentTaskId=TASK-001）+ 群聊可见路线图 + 根任务收口 ——
    const taskIdByPlanId = new Map<string, string>();
    const nodeStates = new Map<string, { status: "pending" | "running" | "completed" | "failed"; retries: number; taskId: string; note?: string }>();
    const deliverables = new Map<string, { output: string; changedFiles: string[] }>();
    for (const p of plan) {
      const task: TeamTask = {
        id: `TASK-${String(taskIdByPlanId.size + this.tasks().length + 1).padStart(3, "0")}`,
        runId: this.runId,
        createdBy: "planner",
        parentTaskId: "TASK-001",
        title: p.title,
        description: p.expectedOutput ? `验收标准：${p.expectedOutput}` : "",
        assignedAgentId: p.agentId,
        status: "pending",
        dependsOn: [],
        expectedOutput: p.expectedOutput,
        planTaskId: p.id,
        retries: 0,
        createdAt: Date.now(),
      };
      taskIdByPlanId.set(p.id, task.id);
      nodeStates.set(p.id, { status: "pending", retries: 0, taskId: task.id });
      this.append({ type: "task_created", task });
    }
    // dependsOn 引用转换到真实 TeamTask.id（供 UI/DAG 视图展示；调度权威态在 nodeStates）
    const tasksNow = () => this.store.rebuildProjections().projections.tasks;
    for (const p of plan) {
      const t = tasksNow().find((x) => x.planTaskId === p.id);
      if (t && p.dependsOn.length > 0) {
        t.dependsOn = p.dependsOn.map((d) => taskIdByPlanId.get(d)!).filter(Boolean);
      }
    }
    this.append({ type: "task_completed", taskId: "TASK-001" }); // 根任务：已被计划拆解
    this.publish();
    this.append({
      type: "message_created",
      message: {
        id: `msg-${this.runId}-plan`,
        kind: "system",
        role: "",
        content: [
          `📋 执行计划已生成（${plan.length} 个任务，无依赖的任务将并行执行）：`,
          ...plan.map((p) => `${p.id}[${this.team.agents.find((a) => a.id === p.agentId)?.name ?? p.agentId}] ${p.title}${p.dependsOn.length ? ` ←依赖 ${p.dependsOn.join(",")}` : ""}`),
        ].join("\n"),
        createdAt: Date.now(),
      },
    });
    this.publish();

    // —— Phase B：按就绪集波次派发（时间预算按计划实际参与角色数分摊，闲置角色不稀释） ——
    const planParticipants = new Set(plan.map((p) => p.agentId)).size;
    const nameOf = (id: string) => this.team.agents.find((a) => a.id === id)?.name ?? id;
    while (true) {
      if (this.cancelled) break;
      if (Date.now() - this.startedAt > this.team.maxRunMinutes * 60_000) {
        this.terminal = { code: "timeout", message: `运行超过 ${this.team.maxRunMinutes} 分钟` };
        break;
      }
      if (this.run.stats.hopCount >= this.team.maxHops) {
        this.terminal = { code: "max_hops", message: `达到最大 Hop 数 ${this.team.maxHops}` };
        break;
      }

      // 下游级联：前置终败的任务不再可执行 → 直接标 failed 防死锁
      let cascaded = true;
      while (cascaded) {
        cascaded = false;
        for (const p of plan) {
          const st = nodeStates.get(p.id)!;
          if (st.status !== "pending") continue;
          const failedDeps = p.dependsOn.filter((d) => nodeStates.get(d)?.status === "failed");
          if (failedDeps.length > 0) {
            st.status = "failed";
            st.note = `前置任务未完成：${failedDeps.join(",")}`;
            this.append({ type: "task_failed", taskId: st.taskId, reason: st.note });
            cascaded = true;
          }
        }
      }

      const ready = plan.filter((p) => {
        const st = nodeStates.get(p.id)!;
        return st.status === "pending" && p.dependsOn.every((d) => nodeStates.get(d)?.status === "completed");
      });
      if (ready.length === 0 && plan.every((p) => nodeStates.get(p.id)!.status !== "pending")) {
        break; // 全部 completed/failed → 进入收尾
      }
      if (ready.length === 0) continue; // 级联后仍可能有 pending（不会发生：pending 必有全 completed 前置或已级联），防御空转一帧

      await Promise.all(
        ready.map(async (p) => {
          const st = nodeStates.get(p.id)!;
          st.status = "running";
          const agent = this.team.agents.find((a) => a.id === p.agentId);
          if (!agent) { st.status = "failed"; st.note = `角色不存在：${p.agentId}`; return; }
          const planById = new Map(plan!.map((x) => [x.id, x] as const));
          const upstream = p.dependsOn.map((d) => ({
            taskId: d,
            title: planById.get(d)!.title,
            output: deliverables.get(d)?.output ?? "",
            changedFiles: deliverables.get(d)?.changedFiles ?? [],
            agentId: planById.get(d)!.agentId,
          }));
          const retryNote = st.retries > 0 ? (st.note ?? "上次执行失败") : undefined;
          const contextOverride = buildTaskContext({
            team: this.team,
            run: this.run,
            agent,
            taskId: st.taskId,
            taskTitle: p.title,
            expectedOutput: p.expectedOutput,
            upstream,
            retryNote,
          });
          const { execution, result } = await this.spawnExecution(p.agentId, { contextOverride, participantCount: planParticipants });
          const ok = result.status === "completed" && result.verdict !== "fail";
          if (ok) {
            st.status = "completed";
            deliverables.set(p.id, {
              output: result.output,
              changedFiles: (result.changedFiles ?? []).map((f) => f.filePath),
            });
            this.append({ type: "task_completed", taskId: st.taskId });
            this.append({
              type: "message_created",
              message: {
                id: `msg-${execution.id}-task-done`,
                kind: "system",
                role: "",
                content: `✅ ${p.id}[${nameOf(p.agentId)}]「${p.title}」完成${result.changedFiles?.length ? `（改动 ${result.changedFiles.length} 个文件）` : ""}`, 
                createdAt: Date.now(),
              },
            });
          } else {
            st.retries += 1;
            st.note = result.failureReason?.trim() || result.output.trim() || `状态 ${result.status}${result.verdict ? `,verdict=${result.verdict}` : ""}`;
            if (st.retries > maxRework) {
              st.status = "failed";
              this.append({ type: "task_failed", taskId: st.taskId, reason: st.note.slice(0, 300) });
              this.append({
                type: "message_created",
                message: { id: `msg-${execution.id}-task-failed`, kind: "system", role: "", content: `❌ ${p.id}[${nameOf(p.agentId)}]「${p.title}」重试 ${maxRework} 次后仍失败，后续依赖任务将被跳过。原因：${st.note.slice(0, 200)}`, createdAt: Date.now() },
              });
            } else {
              st.status = "pending"; // 回队等待重派（下一波就绪判定命中它）
              this.append({
                type: "message_created",
                message: { id: `msg-${execution.id}-task-retry`, kind: "system", role: "", content: `🔁 ${p.id}[${nameOf(p.agentId)}]「${p.title}」未通过（${st.retries}/${maxRework}），将附失败反馈重试。原因：${st.note.slice(0, 200)}`, createdAt: Date.now() },
              });
            }
          }
          this.publish();
        }),
      );
    }
    if (this.terminal) {
      this.finish(this.terminal.code, this.terminal.message);
      return;
    }
    if (this.cancelled) {
      this.finish("user_cancelled", "用户取消");
      return;
    }

    // —— Phase C：收尾报告（即使有阻塞也 best-effort 汇总，入口角色输出最终交付总结） ——
    const failedIds = plan.filter((p) => nodeStates.get(p.id)!.status === "failed");
    const summaryLines = plan.map((p) => {
      const st = nodeStates.get(p.id)!;
      const mark = st.status === "completed" ? "✅" : "❌";
      const body = st.status === "completed" ? deliverables.get(p.id)?.output ?? "" : st.note ?? "失败";
      return `- ${mark} ${p.id}[${nameOf(p.agentId)}]「${p.title}」：${body.replace(/\n+/g, " ").slice(0, 300)}`;
    });
    const finisher = this.team.agents.find((a) => a.id === entry);
    if (finisher) {
      const contextOverride = [
        `# 项目组最终汇总（你的角色：${finisher.name}）`,
        `\n## 原始用户需求`,
        this.run.task,
        `\n## 各任务执行结果（结构化交付物）`,
        summaryLines.join("\n"),
        failedIds.length > 0 ? `\n注意：有 ${failedIds.length} 个子任务最终失败（上方标 ❌），请在报告中如实说明已完成部分与遗留风险。` : "",
        `\n请以组长身份输出面向用户的最终交付总结：完成了什么、改动哪些文件/如何验证、遗留风险与建议。不要再调用交接工具。`,
      ].filter(Boolean).join("\n");
      await this.spawnExecution(entry, { contextOverride });
    }

    this.finish("completed", failedIds.length > 0 ? `DAG 计划执行完成（${failedIds.length} 个子任务未通过，详见群聊记录）` : "DAG 计划全部任务执行完成");
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
    // 判定输入：优先用「到达本网关的分支聚合」（多分支聚合保留全部信息；旧实现用全局
    // 最后完成的输出，并行场景下会拿错分支），缺失时回退全局 last 输出。
    const acc = this.gatewayInputs.get(gateway.id);
    const gatewayContext = {
      status: acc?.statuses[acc.statuses.length - 1] ?? this.lastStatus,
      lastOutput: acc && acc.outputs.length > 0 ? acc.outputs.join("\n\n---\n\n") : this.lastOutput,
    };
    this.gatewayInputs.delete(gateway.id); // 消费即清除（下一轮重新累积）
    const targets = await this.workflow.resolveGateway(gateway, gatewayContext);
    if (targets.length === 0) {
      this.terminal = { code: "workflow_dead_end", message: `网关「${gateway.name}」无匹配出边` };
      return;
    }
    for (const to of targets) this.ready.push(to);
  }

  /** 执行一个角色（= 一个 pi 会话回合），并把路由后的下一节点 feed 进调度流 */
  /** 公共执行体（新旧两个泵共用）：发 execution_started → 选上下文构建器 → 调 executor →
   *  发 execution_completed + 统计。不再包含任何路由/调度语义（那是 launchAgent/pumpDag 的职责）。
   *  opts.planner：DAG 计划轮——注入 team_submit_plan 工具，executor 在 result.plan 透出计划。
   *  opts.contextOverride：DAG 任务轮用任务级精简上下文替换全量共享上下文。 */
  private async spawnExecution(
    agentId: string,
    opts?: { planner?: boolean; planError?: string; contextOverride?: string; participantCount?: number },
  ): Promise<{ execution: AgentExecution; result: ExecutionResult }> {
    const seq = (this.agentExecutionCounts.get(agentId) ?? 0) + 1;
    this.agentExecutionCounts.set(agentId, seq);
    const execution: AgentExecution = {
      // execution.id 保持每次执行唯一（事件路由/审计用），而 sessionId/sessionPath 收敛为
      // 「每角色一份」：同一个角色多次执行（返工/重进）复用同一份 pi 会话 .jsonl 与总结 .md，
      // 避免两个角色跑几轮就堆出十几个文件（用户反馈）。PiAgentExecutor 用 SessionManager.open
      // 对已存在文件走「加载续跑」分支，未存在则新建；兼顾角色跨轮次上下文连续性。
      id: `${this.runId}-${agentId}-${seq}`,
      runId: this.runId,
      agentId,
      sequence: seq,
      status: "running",
      startedAt: Date.now(),
      sessionId: `${this.runId}-${agentId}`,
      sessionPath: join(getTeamDir(this.team.sessionId), "sessions", `${this.runId}-${agentId}.jsonl`),
    };
    this.append({ type: "execution_started", execution });

    const { projections } = this.store.rebuildProjections();
    const agent = this.team.agents.find((a) => a.id === agentId);
    const context = opts?.contextOverride ?? (agent ? buildContext({ team: this.team, run: this.run, projections, agent }) : this.run.task);

    let result: ExecutionResult;
    try {
      result = await this.executor.run({
        team: this.team,
        runId: this.runId,
        execution,
        context,
        task: this.run.task,
        existingTasks: projections.tasks,
        mode: this.solo ? "solo" : "orchestrated",
        planner: opts?.planner === true,
        ...(opts?.planError ? { planError: opts.planError } : {}),
        ...(opts?.participantCount ? { participantCount: opts.participantCount } : {}),
        // 把取消信号传给 executor：用户停止对话时立即 abort 本次会话
        signal: this.controller.signal,
        onEvent: (e) => this.append(e as TeamEventInput),
        onMessage: (m) => this.append({ type: "message_created", message: m as TeamMessage }),
      });
    } catch (error) {
      // 执行器抛异常不冒泡：闭合为 failed，保持事件流与投影一致（execution 不悬挂）
      const message = error instanceof Error ? error.message : String(error);
      result = { status: "failed", output: "", failureReason: `执行器异常：${message}` };
    }

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
      ...(result.model ? { model: result.model } : {}),
      ...(result.changedFiles?.length ? { changedFiles: result.changedFiles } : {}),
      ...(result.readFiles?.length ? { readFiles: result.readFiles } : {}),
      ...(result.thinkingPath ? { thinkingPath: result.thinkingPath } : {}),
    });
    // L1 自动共享层：落文件接触账本（下棒角色的「上棒接触清单」数据源），
    // 写失败不影响主流程（recordTouchedFiles 内部吞错）。
    if (result.changedFiles?.length || result.readFiles?.length) {
      recordTouchedFiles(
        this.team.sessionId,
        this.runId,
        execution.agentId,
        {
          changedFiles: (result.changedFiles ?? []).map((f) => f.filePath),
          readFiles: result.readFiles ?? [],
        },
      );
    }
    this.publish();
    return { execution, result };
  }

  private async launchAgent(nodeId: string): Promise<void> {
    this.gatewaySteps = 0; // 有 Agent 执行，网关链计数清零
    const agentId = nodeId;
    const { execution, result } = await this.spawnExecution(agentId);
    const seq = this.agentExecutionCounts.get(agentId) ?? 1; // spawnExecution 已递增
    const agent = this.team.agents.find((a) => a.id === agentId);

    // 成功完成：①记入「已完成角色」集合 ②自动完结该角色名下仍 open 的子任务。
    // 根因：下游角色完成但任务没被 team_complete_task 标完成时，leader 重派时看到「任务未完成」
    // 就再次重派同一角色 → 无限 ping-pong 直到 max_rework。这里兜底把名下任务自动收口。
    if (result.status === "completed") {
      this.completedAgentIds.add(agentId);
      this.completeOpenTasksFor(agentId);
    }

    // 记录最近输出/状态（网关 exclusive/inclusive 判定输入）
    this.lastOutput = result.output;
    this.lastStatus = result.status === "timeout" ? "timeout" : result.status;

    // P0-1：solo 降级 — 简单任务只跑入口角色即收尾，不做多角色拆解接力。
    // solo 升级为编排：入口角色显式调用 team_handoff 交接下游（非 __end__）= 执行者判断
    // 任务超出单人闭环。这是对分类器「宁 solo 勿编排」启发式的必要纠错通道：task-classify
    // 把中型实现任务也判成 simple，leader 执行中发现干不完而交接——旧实现硬吞交接直接收尾
    //（交接意图只落事件不派发，leader 声称「已交接」而下游永不执行，实锤：
    // leader 输出「已交接给 fe-developer」但 run 以 solo completed 结束，实现部分没人干）。
    // 升级后走正常路由实际派发下游；错误代价从「任务没完成」降为「升级成编排」。
    if (this.solo) {
      if (result.handoffTool && result.handoffTool.to !== END_NODE) {
        this.solo = false; // 后续 spawnExecution 以 orchestrated 跑（工具链/写权限不再按 solo）
        this.append({
          type: "handoff_requested",
          executionId: execution.id,
          from: agentId,
          to: result.handoffTool.to,
          kind: "tool",
          reason: `入口角色在 solo 执行中显式交接给 ${result.handoffTool.to} —— 任务超出单人闭环，升级为多角色编排继续执行`,
        });
        this.append({
          type: "message_created",
          message: {
            id: `msg-${this.runId}-solo-escalate`,
            kind: "system",
            role: "",
            content: `⬆️ 简单任务分类需纠错：入口角色「${agentId}」在 solo 执行中显式交接给「${result.handoffTool.to}」，已升级为多角色编排继续执行（不再单角色收尾）。`,
            createdAt: Date.now(),
          },
        });
        this.publish();
        // 直接按显式意图路由（不能落 resolveRoute：strict 路由模式会忽略 tool handoff——
        // engine「strict 忽略工具」；升级路径以执行者的显式交接意图为准）。
        this.ready.push(result.handoffTool.to);
        return;
      } else {
        this.terminal = { code: "completed", message: "简单任务由入口角色直接完成（solo）" };
        return;
      }
    }

    // —— 路由决策 ——
    const route = await this.workflow.resolveRoute({ agentId, status: result.status }, result, seq);

    // verdict/路由不一致警示（修 bcfc16cd 误派④的可见性）：角色已记录结构化 verdict，
    // 但最终却走了裸关键词/always 路由——说明配置里缺少对应 verdictGuard 边或 guard 不匹配，
    // 提醒用户修边/检查角色是否漏记 verdict；否则下次仍可能把返工误派给错误角色。
    if (result.verdict && route?.kind === "transition" && !String(route.reason ?? "").startsWith("verdict")) {
      this.append({
        type: "message_created",
        message: {
          id: `msg-${execution.id}-verdict-mismatch`,
          kind: "system",
          executionId: execution.id,
          agentId,
          role: "",
          content: `⚠️ 路由提示：角色「${this.team.agents.find((a) => a.id === agentId)?.name ?? agentId}」已记录 verdict=${result.verdict}，但本次实际走了 ${route.reason} 路由（→ ${route.to}）。请检查 transitions 是否为该角色的 completed 事件配置了匹配的 verdictGuard 边。`,
          createdAt: Date.now(),
        },
      });
    }

    // —— no-progress 循环守卫 ——
    // 入口角色(leader)用 team_handoff（kind=tool）重复交接给「已成功完成过、且名下已无未完成任务」的
    // 下游角色：这是 leader 反复空转的典型信号（本轮真实故障「leader ⇄ be-developer」无限 ping-pong
    // 直到 max_rework）。检测到即收敛收尾：让 run 以 best-effort 完成（而非 max_rework 硬失败），
    // 避免多 Agent 空转烧 token。仅针对 handoff 工具造成的循环（transitions 构成的循环仍交给
    // maxHops 保险丝，避免语义混淆）。
    // 判定：①入口角色 ②交接目标是已成功完成过的角色 ③该角色名下无未完成任务（leader 没派新活，纯重派）
    //       ④入口角色已重复交接该角色 ≥2 次。
    if (
      agentId === this.team.entryAgentId &&
      route &&
      route.kind === "tool" &&
      route.to !== END_NODE &&
      route.to !== this.team.entryAgentId
    ) {
      const to = route.to;
      this.entryHandoffCounts.set(to, (this.entryHandoffCounts.get(to) ?? 0) + 1);
      if (
        this.entryHandoffCounts.get(to)! >= RunManager.NO_PROGRESS_HANDOFF_THRESHOLD &&
        this.completedAgentIds.has(to) &&
        !this.hasOpenTask(to)
      ) {
        const agent = this.team.agents.find((a) => a.id === to);
        this.append({
          type: "message_created",
          message: {
            id: `msg-${execution.id}-noloop`,
            kind: "system",
            executionId: execution.id,
            agentId,
            role: agent?.name ?? agentId,
            content: `检测到组长反复交接给「${agent?.name ?? to}」而无进展（该角色已成功完成且名下无未完成任务）。为避免空转，自动收敛收尾。`,
            createdAt: Date.now(),
          },
        });
        this.publish();
        this.terminal = { code: "completed", message: "组长反复交接无进展，自动收敛为完成" };
        return;
      }
    }


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
        const verdict = await this.waitForApproval(req);
        if (!verdict.approved) {
          this.terminal = verdict.timedOut
            ? { code: "timeout", message: "审批等待超时（无人响应），运行终止" }
            : { code: "user_cancelled", message: "审批被驳回，运行终止" };
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
        // 目标是网关：记录本次分支的状态/输出供该网关消费（并行波次竞态修复）。
        // 同时去重：并行分支都会 feed 同一网关，若每支各推一次入 ready，网关会被
        // 消费多次——第一次用完整聚合、第二次只剩兑底输入 → 判定漂移 + 下游重复执行。
        if (this.isGateway(finalRoute.to)) {
          this.recordGatewayInput(finalRoute.to, result.status === "timeout" ? "timeout" : result.status, result.output);
          if (!this.ready.includes(finalRoute.to)) this.ready.push(finalRoute.to);
        } else {
          this.ready.push(finalRoute.to);
        }
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
    // 并行/包容编排中某分支失败（event=failed 无匹配边）：不应回入口破坏 merge 汇聚。
    // 若该角色原本的出边指向某 merge（它是并行区一个分支），则以其失败态直接到达该 merge，
    // 让 merge 计数完整、仍能推进汇聚下游（如 tester 交叉验证），失败信息也随事件下游客可见。
    if (result.status === "failed") {
      const mergeTarget = this.mergeTargetForAgent(agentId);
      if (mergeTarget) {
        this.append({
          type: "message_created",
          message: {
            id: `msg-${execution.id}-fail`,
            kind: "system",
            executionId: execution.id,
            agentId,
            role: agent?.name ?? agentId,
            content: `⚠️ ${agent?.name ?? agentId} 执行失败：${result.failureReason ?? "未知"}`,
            createdAt: Date.now(),
          },
        });
        this.append({
          type: "handoff_requested",
          executionId: execution.id,
          from: agentId,
          to: mergeTarget,
          kind: "transition",
          reason: `分支失败，以失败态到达汇聚点：${result.failureReason ?? ""}`,
        });
        this.publish();
        this.arriveMerge(mergeTarget, execution.id);
        return;
      }
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

  /** 该角色是否为某 merge 的入边来源（并行/包容区一个分支）；是则返回该 merge id（供失败分支以失败态汇聚） */
  private mergeTargetForAgent(agentId: string): string | null {
    const t = this.team.transitions.find((tr) => tr.enabled !== false && tr.from === agentId && this.isMergeNode(tr.to));
    return t ? t.to : null;
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
    if (this.cancelled) return;
    this.cancelled = true;
    this.abortInflight();
    this.approvalResolver?.(false);
    // 兜底：即使 executor 对 abort 无响应（真实 prompt 卡死），也强制在 cancelForceMs 后收敛为取消，
    // 避免用户点停止但 run 一直卡在「正在执行」。正常路径（executor 响应 abort）会先 finish，此定时器即空转。
    this.cancelForceTimer = setTimeout(() => {
      if (!this.finished) {
        this.finish("user_cancelled", "用户取消（执行器未响应中止，强制收敛）");
      }
    }, this.cancelForceMs);
    (this.cancelForceTimer as NodeJS.Timeout).unref?.();
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

  /** 当前任务列表（从事件流重建投影） */
  /** DAG 回退旧引擎前的状态重置（hopCount/tokens 不重置——全局预算持续生效） */
  private resetForLegacyPump(): void {
    this.ready = [this.team.entryAgentId];
    this.inflight = 0;
    this.mergeState.clear();
    this.gatewaySteps = 0;
    this.endReached = false;
    this.terminal = null;
    this.lastOutput = "";
    this.lastStatus = "completed";
    this.gatewayInputs.clear();
    this.entryHandoffCounts.clear();
    this.softTimeoutFired = false;
  }

  private tasks(): TeamTask[] {
    return this.store.rebuildProjections().projections.tasks;
  }

  /** 某角色名下是否还有未完成任务（pending/running） */
  private hasOpenTask(agentId: string): boolean {
    return this.tasks().some((t) => t.assignedAgentId === agentId && (t.status === "pending" || t.status === "running"));
  }

  /** 成功执行后自动完结该角色名下所有 open 的任务（补 team_complete_task 漏标） */
  private completeOpenTasksFor(agentId: string): void {
    let changed = false;
    for (const t of this.tasks()) {
      if (t.assignedAgentId === agentId && (t.status === "pending" || t.status === "running")) {
        this.append({ type: "task_completed", taskId: t.id });
        changed = true;
      }
    }
    if (changed) this.publish();
  }


  /** 简单任务 solo 降级判定：complexity=simple 时只跑入口角色，像普通会话直接交付
   *  （发布时已由 classifyTask 判定写入 run.complexity；不再依赖旧关键词表）。
   *  autoSolo 仍作为显式开关生效：autoSolo===false 时，即使复杂度 simple 也走完整编排
   *  （用户取消「简单任务降级」即关闭 solo）；undefined/true 时默认 simple→solo。
   *  修复：此前只读 run.complexity，导致 UI 里该开关勾选与否都无区别（完全失效）。 */
  private shouldSolo(run: TeamRun): boolean {
    if (this.team.autoSolo === false) return false;
    return run.complexity === "simple";
  }

  /** P1-2：等待用户审批（命中 approval 边时暂停）。approve()/reject() 唤醒。
   *  超时保险丝：超过 effectiveApprovalWaitMs()（显式超时与 maxRunMinutes 剩余额度取小）
   *  仍无响应 → 按「运行时自动驳回」收敛并落系统消息，避免 run 永久挂起、绕过全部保险丝。
   *  settle 幂等、先到者赢（user approve/reject / runtime 超时 / cancel() 驳回三路竞速）；
   *  resolve 后清空 approvalResolver——旧实现不清空，晚到的 approve() 会重复发
   *  approval_resolved 事件并把已结束 run 的 status 改回 running。 */
  private waitForApproval(req: ApprovalRequest): Promise<{ approved: boolean; timedOut: boolean }> {
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
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (approved: boolean, by: "user" | "runtime"): boolean => {
        if (settled) return false;
        settled = true;
        if (timer) clearTimeout(timer);
        this.approvalResolver = undefined;
        this.append({ type: "approval_resolved", runId: this.runId, transitionId: req.transitionId, approved, by });
        this.run.pendingApproval = undefined;
        if (approved) this.run.status = "running";
        this.publish();
        return true;
      };
      const fireTimeout = () => {
        const won = settle(false, "runtime");
        if (!won) return;
        this.append({
          type: "message_created",
          message: {
            id: `msg-approval-timeout-${req.transitionId}-${Date.now()}`,
            kind: "system",
            role: "系统",
            content: `⏱️ 审批等待超时（约 ${Math.max(Math.round(this.approvalTimeoutMs / 60_000), 1)} 分钟无人响应），已按运行时策略自动驳回并终止运行。如需继续，请重新发布任务并在审批请求出现时及时处理。`,
            createdAt: Date.now(),
          },
        });
        this.publish();
        resolve({ approved: false, timedOut: true });
      };
      this.approvalResolver = (approved) => {
        const ok = settle(approved, "user");
        if (ok) resolve({ approved, timedOut: false });
      };
      const waitMs = this.effectiveApprovalWaitMs();
      if (Number.isFinite(waitMs)) {
        if (waitMs <= 0) {
          fireTimeout(); // 总时长预算已耗尽：立即超时收敛
        } else {
          timer = setTimeout(fireTimeout, waitMs);
          // 注意不 unref：有审批待处理时进程应存活到超时兑底触发（否则事件循环空转时
          // 兜底永不执行，run 又退化为永久挂起）。
        }
      }
    });
  }

  /** 审批等待上限：min(配置的 approvalTimeoutMs, maxRunMinutes 的剩余额度)。Infinity=显式禁用 */
  private effectiveApprovalWaitMs(): number {
    const configured = this.approvalTimeoutMs;
    if (!Number.isFinite(configured)) return Infinity;
    const deadline = this.startedAt + this.team.maxRunMinutes * 60_000;
    const remaining = deadline - Date.now();
    return Math.min(Math.max(configured, 0), remaining);
  }

  /** 记录一次「agent 完成 → 到达网关」的分支输入（同轮多分支累积，网关消费后清除） */
  private recordGatewayInput(gatewayId: string, status: ExecutionStatus | "timeout", output: string): void {
    const acc = this.gatewayInputs.get(gatewayId) ?? { statuses: [], outputs: [] };
    acc.statuses.push(status);
    acc.outputs.push(output);
    this.gatewayInputs.set(gatewayId, acc);
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
    if (this.finished) return;
    this.finished = true;
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
