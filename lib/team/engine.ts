/**
 * WorkflowEngine（设计稿 v5 §7.3）：路由判定。
 *
 * 判定顺序固定（一次路由决策最多一次 LLM 调用）：
 *   1. explicit handoff（team_handoff 工具，Agent 明确意图）[hybrid/autonomous；strict 忽略]
 *   2. Transition.keyword / always（便宜，priority DESC 取第一个命中）
 *   3. Transition.llm（最后决策器：对候选集一次性判定）
 */
import type { Condition, ExecutionStatus, ExecutionStats, GatewayDef, PlanTask, RoutingMode, TeamDef, Transition } from "./types.ts";
import { stripNoise } from "./validate.ts";

export interface ExecutionResult {
  status: ExecutionStatus | "timeout";
  output: string;                              // 角色最终输出文本（截断后）
  handoffTool?: {                              // team_handoff 工具结果
    to: string;
    summary: string;
    artifacts?: string[];
    blockers?: string[];
  };
  /** 结构化裁决（P1-1）：角色经 team_record_decision 记录的 verdict，路由优先据此而非赌 keyword */
  verdict?: "pass" | "fail";
  /** 角色最后一条 team_record_decision 的 content：verdict 同向多边消歧时，优先用它（角色自述的问题归属）
   *  而非混杂全文做关键词判定——修 bcfc16cd「tester 报前端问题因文中含‘后端’被误派 be-developer」④。 */
  decisionContent?: string;
  /** DAG 编排：planner 轮经 team_submit_plan 提交并通过校验的计划（调度器据此派发） */
  plan?: PlanTask[];
  /** planner 轮计划提交失败的纠错信息（供 runtime 发起重试轮） */
  planError?: string;
  failureReason?: string;
  stats?: ExecutionStats;                      // 回合统计（token/成本/消息数）
  /** 本次执行实际生效的模型（agent.model 显式指定，或空=跟随全局默认后由会话解析出的具体模型）。
   *  供 UI 在角色输出/执行徽标处展示「用了什么模型」，尤其「跟随系统」时也能显示具体模型名。 */
  model?: { provider: string; modelId: string };
  /** 本次执行改动/生成的文件（edit/write；站在项目 cwd 内），供 UI 像普通会话那样展示「变更文件」 */
  changedFiles?: { filePath: string; kind: "edit" | "write" }[];
  /** 本次执行思考流水落盘的 .md 路径（可读，供「查看思考文件」右开；无思考则为 undefined） */
  thinkingPath?: string;
}

export interface Route {
  kind: "transition" | "tool";
  from: string;
  to: string;
  transitionId?: string;
  reason?: string;
  payload?: ExecutionResult["handoffTool"];
}

/** LLM 判定器（Phase 1A 可注入 mock；未提供则 llm 条件永不命中，安全降级） */
export interface LlmJudge {
  (candidates: Array<{ transition: Transition; agentOutput: string }>): Promise<Transition | null>;
}

export class WorkflowEngine {
  private readonly team: TeamDef;
  private readonly llmJudge?: LlmJudge;

  constructor(team: TeamDef, llmJudge?: LlmJudge) {
    this.team = team;
    this.llmJudge = llmJudge;
  }

  /** 生效的路由模式：Agent.routingPolicy 覆盖团队默认 */
  effectiveMode(agentId: string): RoutingMode {
    const agent = this.team.agents.find((a) => a.id === agentId);
    if (agent?.routingPolicy && agent.routingPolicy !== "inherit") return agent.routingPolicy;
    return this.team.defaultRoutingMode;
  }

  async resolveRoute(
    execution: { agentId: string; status: ExecutionStatus | "timeout" },
    result: ExecutionResult,
    executionSeq?: number,
  ): Promise<Route | null> {
    const mode = this.effectiveMode(execution.agentId);

    // 1) explicit handoff：Agent 明确意图，最可靠（strict 忽略工具）
    if (mode !== "strict" && result.handoffTool) {
      return {
        kind: "tool",
        from: execution.agentId,
        to: result.handoffTool.to,
        payload: result.handoffTool,
        reason: "team_handoff",
      };
    }

    // 2) 候选 Transition：from 匹配 + 事件匹配 + onlyExecutionSeq 匹配，priority DESC
    const candidates = matchingTransitions(this.team, execution.agentId, execution.status, executionSeq);

    // 2.5) 结构化裁决优先（P1-1）：角色已 record_decision 记录 pass/fail → 匹配对应 verdictGuard 边，
    //      不依赖输出文本里是否出现“通过/问题/bug”等词，规避模型随机性导致的 keyword 漏判。
    //      同向多边消歧（修 bcfc16cd 误派④）：fail 边同时连 fe/be-developer 时，
    //      用 record_decision content（角色自述问题归属）> 交接摘要（仅 strict 模式可达此层）> 全文
    //      做关键词判定；都无命中则取 priority 最高的第一条。
    //      另外整个 2.5 层在任意 verdictGuard 命中时短路，不再落入裸关键词层——
    //      这是本案例误派的直接路径：无 guard 的 p21「后端」边抢在 guard fail p20/p21 前面命中。
    if (result.verdict) {
      const guarded = candidates
        .filter((t) => t.verdictGuard === result.verdict)
        .sort((a, b) => b.priority - a.priority);
      if (guarded.length > 0) {
        let t = guarded[0];
        if (guarded.length > 1) {
          // 消歧输入优先级：record_decision content（角色自述问题归属）> 交接摘要 > 全文
          const hay = result.decisionContent?.trim() || result.handoffTool?.summary?.trim() || result.output || "";
          // 最早命中位置优先：否定从句（如「与后端无关」）往往晚于真正的归属词，
          //   按「谁的关键词在文中出现得更早」选边（guarded 已按 priority DESC，平局保序取高优）
          let bestPos = -1;
          for (const g of guarded) {
            const pos = keywordMatchPosition(g.trigger.condition, hay);
            if (pos >= 0 && (bestPos < 0 || pos < bestPos)) {
              t = g;
              bestPos = pos;
            }
          }
        }
        return { kind: "transition", from: execution.agentId, to: t.to, transitionId: t.id, reason: `verdict:${result.verdict}` };
      }
    }

    // 3) keyword / always（便宜先试）—— priority DESC 取第一个命中
    for (const t of candidates) {
      const cond = t.trigger.condition;
      if (!cond || cond.mode === "always" || cond.mode === "keyword") {
        if (judgeCheap(cond, result.output)) {
          return { kind: "transition", from: execution.agentId, to: t.to, transitionId: t.id, reason: cond?.mode ?? "always" };
        }
      }
    }

    // 4) LLM judge：最后决策器，候选集一次调用（最多一次 LLM）
    const llmCandidates = candidates.filter((t) => t.trigger.condition?.mode === "llm");
    if (llmCandidates.length > 0 && this.llmJudge) {
      const chosen = await this.llmJudge(
        llmCandidates.map((t) => ({ transition: t, agentOutput: result.output })),
      );
      if (chosen) {
        return { kind: "transition", from: execution.agentId, to: chosen.to, transitionId: chosen.id, reason: "llm" };
      }
    }

    return null;
  }

  /**
   * 网关路由（结构化转发，不消耗 LLM 之外的判定）：
   *  - exclusive：按条件选一条出边（keyword/always/llm + priority，判定输入 = 最近 agent 输出）
   *  - inclusive：命中条件的出边全走（keyword/always；无条件 = 全走）
   *  - parallel：所有 enabled 出边全走
   *  - merge：不在此处理（runtime 计数汇聚）
   */
  async resolveGateway(
    gateway: GatewayDef,
    context: { status: ExecutionStatus | "timeout"; lastOutput: string },
  ): Promise<string[]> {
    const candidates = matchingTransitions(this.team, gateway.id, context.status);
    if (gateway.type === "parallel") return candidates.map((t) => t.to);
    if (gateway.type === "inclusive") {
      const hits = candidates.filter((t) => {
        const cond = t.trigger.condition;
        return !cond || cond.mode === "always" || (cond.mode === "keyword" && judgeCheap(cond, context.lastOutput));
      });
      // llm 条件保守视为命中（包容语义：不明确拒绝就放行）
      const llm = candidates.filter((t) => t.trigger.condition?.mode === "llm");
      return [...hits, ...llm].map((t) => t.to);
    }
    // exclusive：priority DESC 取第一个命中（与角色出边一致）
    for (const t of candidates) {
      const cond = t.trigger.condition;
      if (!cond || cond.mode === "always" || cond.mode === "keyword") {
        if (judgeCheap(cond, context.lastOutput)) return [t.to];
      }
    }
    const llmCandidates = candidates.filter((t) => t.trigger.condition?.mode === "llm");
    if (llmCandidates.length > 0 && this.llmJudge) {
      const chosen = await this.llmJudge(
        llmCandidates.map((t) => ({ transition: t, agentOutput: context.lastOutput })),
      );
      if (chosen) return [chosen.to];
    }
    return [];
  }
}

/** 便宜条件判定：always 恒真；keyword 先屏蔽代码块/引用块，rejectKeywords 优先 */
export function judgeCheap(cond: Condition | undefined, output: string): boolean {
  if (!cond || cond.mode === "always") return true;
  if (cond.mode === "keyword") {
    const clean = stripNoise(output).toLowerCase();
    if (cond.rejectKeywords?.some((k) => k.toLowerCase() && clean.includes(k.toLowerCase()))) return false;
    if (cond.keywords?.some((k) => k && clean.includes(k.toLowerCase()))) return true;
    return false;
  }
  return false; // llm 走 resolveRoute 的最后决策器
}

/** 关键词在文本中的最早命中位置（字符索引）；无命中或被 rejectKeywords 否决返回 -1。
 *  供 verdict 同向多边消歧用：角色自述问题归属时，根因词通常出现在句首（「根因在前端…与后端无关」），
 *  最早位置比 any-match 更能代表归属，避免否定从句里的反向关键词抢路由。 */
function keywordMatchPosition(cond: Condition | undefined, output: string): number {
  if (!cond || cond.mode !== "keyword" || !cond.keywords?.length) return -1;
  const clean = stripNoise(output).toLowerCase();
  if (cond.rejectKeywords?.some((k) => k.toLowerCase() && clean.includes(k.toLowerCase()))) return -1;
  let best = -1;
  for (const k of cond.keywords) {
    if (!k) continue;
    const idx = clean.indexOf(k.toLowerCase());
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}

/** 静态辅助：给定节点（Agent 或网关）与事件，返回匹配的候选（priority DESC）。
 *  executionSeq：Agent 的第几次执行（1 起）。仅当传入时，才过滤 `onlyExecutionSeq` 不匹配的边；
 *  网关解析不传该值，故网关边不受 onlyExecutionSeq 影响。 */
export function matchingTransitions(
  team: TeamDef,
  nodeId: string,
  event: ExecutionStatus | "timeout",
  executionSeq?: number,
): Transition[] {
  return team.transitions
    .filter(
      (t) =>
        t.enabled !== false &&
        t.from === nodeId &&
        (t.trigger.event === event || t.trigger.event === "any") &&
        (t.onlyExecutionSeq === undefined || executionSeq === undefined || t.onlyExecutionSeq === executionSeq),
    )
    .sort((a, b) => b.priority - a.priority);
}
