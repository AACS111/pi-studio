/**
 * Workflow 静态校验（设计稿 v5 §3.2）。
 * error 阻断保存；warning 仅提示。保存/编辑团队配置前调用。
 */
import type { AgentDef, Condition, TeamDef, Transition, WorkflowValidationResult } from "./types.ts";

export function validateWorkflow(team: TeamDef): WorkflowValidationResult {
  const errors: WorkflowValidationResult["errors"] = [];
  const warnings: WorkflowValidationResult["warnings"] = [];
  const agentIds = new Set(team.agents.map((a) => a.id));

  const pushError = (code: string, message: string, extra: { transitionId?: string; agentId?: string } = {}) =>
    errors.push({ code, message, ...extra });
  const pushWarning = (code: string, message: string, extra: { transitionId?: string; agentId?: string } = {}) =>
    warnings.push({ code, message, ...extra });

  // ① Entry agent 必须存在（空团队无角色时不报错）
  if (team.agents.length > 0 && (!team.entryAgentId || !agentIds.has(team.entryAgentId))) {
    pushError("entry_agent_missing", `入口角色 "${team.entryAgentId || "(空)"}" 不存在`);
  }

  const gatewayIds = new Set((team.gateways ?? []).map((g) => g.id));
  const isNode = (id: string) => agentIds.has(id) || gatewayIds.has(id);

  // ② 边指向不存在节点 / ③ 自环 / ④ 条件配置非法
  for (const t of team.transitions) {
    if (t.to === "__end__") continue; // 终态节点（流程结束），非 Agent
    if (!isNode(t.to)) {
      pushError("transition_target_missing", `Transition "${t.id}" 指向不存在的节点 "${t.to}"（角色/网关）`, { transitionId: t.id });
    }
    if (!isNode(t.from)) {
      pushError("transition_source_missing", `Transition "${t.id}" 的源节点 "${t.from}" 不存在`, { transitionId: t.id });
    }
    if (t.from === t.to && t.to !== "__end__") {
      pushError("self_loop", `Transition "${t.id}" 是自环（${t.from} → ${t.from}），默认禁止`, { transitionId: t.id });
    }
    // P1-1：verdictGuard 合法性
    if (t.verdictGuard && t.verdictGuard !== "pass" && t.verdictGuard !== "fail") {
      pushError("verdict_guard_invalid", `Transition "${t.id}" 的 verdictGuard 非法：${t.verdictGuard}（仅允许 pass/fail）`, { transitionId: t.id });
    }
    const cond = t.trigger.condition;
    if (cond) {
      if (cond.mode === "keyword" && (!cond.keywords || cond.keywords.length === 0)) {
        pushError("condition_invalid", `Transition "${t.id}" 的 keyword 条件缺少关键词`, { transitionId: t.id });
      }
      if (cond.mode === "llm" && !cond.conditionText?.trim()) {
        pushError("condition_invalid", `Transition "${t.id}" 的 llm 条件缺少 conditionText`, { transitionId: t.id });
      }
    }
  }

  // ②b 网关校验（结构约束）
  for (const gw of team.gateways ?? []) {
    const out = team.transitions.filter((t) => t.from === gw.id && t.enabled !== false).length;
    const inn = team.transitions.filter((t) => t.to === gw.id && t.enabled !== false).length;
    if (!["exclusive", "parallel", "inclusive", "merge"].includes(gw.type)) {
      pushError("gateway_type_invalid", `网关 "${gw.name}" 类型非法：${gw.type}`, { agentId: gw.id });
    }
    if (team.transitions.some((t) => t.from === gw.id && t.to === gw.id)) {
      pushError("gateway_self_loop", `网关 "${gw.name}" 存在自环`, { agentId: gw.id });
    }
    if (gw.type === "exclusive" && out === 0) {
      pushError("gateway_no_out", `排他网关 "${gw.name}" 没有任何出边`, { agentId: gw.id });
    }
    if ((gw.type === "parallel" || gw.type === "inclusive") && out === 0) {
      pushWarning("gateway_no_out", `网关 "${gw.name}" 没有任何出边`);
    }
    if (gw.type === "parallel" && out === 1) {
      pushWarning("gateway_single_out", `并行网关 "${gw.name}" 只有一条出边（并行无意义）`);
    }
    if (gw.type === "merge" && inn === 0) {
      pushWarning("gateway_no_in", `汇聚网关 "${gw.name}" 没有任何入边`);
    }
    if (gw.type === "merge" && inn === 1) {
      pushWarning("gateway_single_in", `汇聚网关 "${gw.name}" 只有一条入边（汇聚无意义）`);
    }
  }
  if (team.entryAgentId && gatewayIds.has(team.entryAgentId)) {
    pushError("entry_gateway", "入口不能是网关节点");
  }

  // ⑤ strict 模式：无出口节点（除 entry——entry 可能靠 handoff 收尾）
  if (team.defaultRoutingMode === "strict" || team.agents.some((a) => a.routingPolicy === "strict")) {
    const outgoing = new Map<string, number>();
    for (const t of team.transitions) outgoing.set(t.from, (outgoing.get(t.from) ?? 0) + 1);
    for (const agent of team.agents) {
      const strict = agent.routingPolicy === "strict" ||
        (agent.routingPolicy !== "hybrid" && agent.routingPolicy !== "autonomous" && team.defaultRoutingMode === "strict");
      if (strict && (outgoing.get(agent.id) ?? 0) === 0 && agent.id !== team.entryAgentId) {
        pushError("strict_dead_end", `strict 模式角色 "${agent.id}" 没有任何出口 Transition`, { agentId: agent.id });
      }
    }
  }

  // ⑥ 不可达（无 incoming）—— 空工作流时（无 transitions）由组长自动安排角色执行，不报 warning
  if (team.transitions.length > 0) {
    const incoming = new Map<string, number>();
    for (const t of team.transitions) incoming.set(t.to, (incoming.get(t.to) ?? 0) + 1);
    for (const agent of team.agents) {
      if (agent.id === team.entryAgentId) continue;
      if ((incoming.get(agent.id) ?? 0) === 0) {
        pushWarning("unreachable", `角色 "${agent.id}" 永远不可达（没有任何边指向它）`, { agentId: agent.id });
      }
    }
  }

  // ⑦ 环检测（可达环）—— 空工作流时跳过
  if (team.transitions.length > 0) {
    const graph = new Map<string, string[]>();
    for (const t of team.transitions) {
      const list = graph.get(t.from) ?? [];
      list.push(t.to);
      graph.set(t.from, list);
    }
    const cycle = findCycle(team, graph);
    if (cycle.length > 0) {
      pushWarning("cycle", `检测到可能的循环路径：${cycle.join(" → ")} → ${cycle[0]}（runtime 有 maxHops 兜底）`);
    }
  }

  // ⑧ 优先级重叠（同 from 同 event 多条 keyword/llm）—— 空工作流时跳过
  if (team.transitions.length > 0) {
    const byFromEvent = new Map<string, Transition[]>();
    for (const t of team.transitions) {
      const key = `${t.from}:${t.trigger.event}`;
      const list = byFromEvent.get(key) ?? [];
      list.push(t);
      byFromEvent.set(key, list);
    }
    for (const [, list] of byFromEvent) {
      if (list.length > 1) {
        pushWarning(
          "priority_overlap",
          `角色 "${list[0].from}" 在事件 ${list[0].trigger.event} 上有 ${list.length} 条边，靠 priority 区分（相同 priority 时按配置顺序取第一条）`,
          { transitionId: list[0].id },
        );
      }
    }
  }

  // ⑨ 重复裁决边（同 from 同 verdictGuard 多条）—— 语义冲突，仅提示
  if (team.transitions.length > 0) {
    const byGuard = new Map<string, Transition[]>();
    for (const t of team.transitions) {
      if (!t.verdictGuard) continue;
      const key = `${t.from}:${t.verdictGuard}`;
      const list = byGuard.get(key) ?? [];
      list.push(t);
      byGuard.set(key, list);
    }
    for (const [, list] of byGuard) {
      if (list.length > 1) {
        pushWarning(
          "verdict_overlap",
          `角色 "${list[0].from}" 在 verdict=${list[0].verdictGuard} 上有 ${list.length} 条边，靠 priority 区分（取第一条命中）`,
          { transitionId: list[0].id },
        );
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** 可达环检测（DFS 染色） */
export function findCycle(team: TeamDef, graph: Map<string, string[]>): string[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  let found: string[] = [];

  const dfs = (node: string): boolean => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!color.has(next) || color.get(next) === WHITE) {
        if (dfs(next)) return true;
      } else if (color.get(next) === GRAY) {
        const start = stack.indexOf(next);
        found = stack.slice(start);
        return true;
      }
    }
    color.set(node, BLACK);
    stack.pop();
    return false;
  };

  for (const agent of team.agents) {
    if (!color.has(agent.id) || color.get(agent.id) === WHITE) {
      if (dfs(agent.id)) break;
    }
  }
  return found;
}

/** 输出中的代码块/引用块屏蔽（keyword 匹配前调用，防误触发） */
export function stripNoise(text: string): string {
  // 移除 ```...``` 代码块
  let out = text.replace(/```[\s\S]*?```/g, " ");
  // 移除行内 `code`
  out = out.replace(/`[^`]*`/g, " ");
  // 移除引用块（> 开头行）
  out = out.replace(/^>\s?.*$/gm, " ");
  return out;
}

/** 条件类型守卫 */
export function conditionOf(t: Transition): Condition | undefined {
  return t.trigger.condition;
}

export type { AgentDef };
