/**
 * WorkflowEngine（设计稿 v5 §7.3）：路由判定。
 *
 * 判定顺序固定（一次路由决策最多一次 LLM 调用）：
 *   1. explicit handoff（team_handoff 工具，Agent 明确意图）[hybrid/autonomous；strict 忽略]
 *   2. Transition.keyword / always（便宜，priority DESC 取第一个命中）
 *   3. Transition.llm（最后决策器：对候选集一次性判定）
 */
import type { Condition, ExecutionStatus, GatewayDef, RoutingMode, TeamDef, Transition } from "./types.ts";
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
  failureReason?: string;
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

    // 2) 候选 Transition：from 匹配 + 事件匹配，priority DESC
    const candidates = matchingTransitions(this.team, execution.agentId, execution.status);

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

/** 静态辅助：给定节点（Agent 或网关）与事件，返回匹配的候选（priority DESC） */
export function matchingTransitions(team: TeamDef, nodeId: string, event: ExecutionStatus | "timeout"): Transition[] {
  return team.transitions
    .filter(
      (t) =>
        t.enabled !== false &&
        t.from === nodeId &&
        (t.trigger.event === event || t.trigger.event === "any"),
    )
    .sort((a, b) => b.priority - a.priority);
}
