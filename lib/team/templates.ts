/**
 * 项目组模板（设计稿 v5 §1.3 / §10）。
 * 模板只是"可配置的起点"：用户创建团队后每个角色/边/限制都可改。
 * 当前内置「软件开发团队」模板；模板市场留到 Phase 3（JSON 导入导出）。
 */
import type { AgentDef, GatewayDef, RoutingMode, TeamDef, Transition } from "./types.ts";
import { agentFromLibrary, BUILTIN_AGENTS } from "./library.ts";

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  build: (sessionId: string, cwd: string, name: string) => TeamDef;
}

/** 软件开发团队：组长 → 产品 → 开发 → 测试（测试发现缺陷返工开发，通过后交回组长总结） */
const SOFTWARE_DEV_TEMPLATE: TeamTemplate = {
  id: "software-dev",
  name: "软件开发团队",
  description: "组长 → 产品 → 开发 → 测试；测试发现问题自动返工开发，通过后组长总结",
  build: (sessionId, cwd, name) => {
    const agents = ["leader", "product", "developer", "tester"]
      .map((id) => BUILTIN_AGENTS.find((a) => a.id === id))
      .filter(Boolean)
      .map((a) => ({ ...agentFromLibrary(a!), workspace: { mode: "team" as const } }));

    const transitions: Transition[] = [
      {
        // 组长收尾：输出总结关键词 → 流程结束（__end__ 终态，非 Agent）
        id: "t0-leader-end",
        from: "leader",
        to: "__end__",
        priority: 30,
        trigger: {
          event: "completed",
          condition: {
            mode: "keyword",
            keywords: ["总结完成", "任务完成", "全部完成", "收尾完成", "结论：", "最终结论"],
          },
        },
      },
      {
        id: "t1-leader-product",
        from: "leader",
        to: "product",
        priority: 0,
        trigger: { event: "completed", condition: { mode: "always" } },
      },
      {
        id: "t2-product-developer",
        from: "product",
        to: "developer",
        priority: 0,
        trigger: { event: "completed", condition: { mode: "always" } },
      },
      {
        id: "t3-developer-tester",
        from: "developer",
        to: "tester",
        priority: 0,
        trigger: { event: "completed", condition: { mode: "always" } },
      },
      {
        // 测试发现问题 → 返工开发（keyword 优先于 always 兜底边）
        id: "t4-tester-developer-rework",
        from: "tester",
        to: "developer",
        priority: 20,
        trigger: {
          event: "completed",
          condition: { mode: "keyword", keywords: ["问题", "失败", "bug", "BUG", "缺陷", "未通过", "不过", "不通过"] },
        },
      },
      {
        // 测试全部通过 → 交回组长总结
        id: "t5-tester-leader-pass",
        from: "tester",
        to: "leader",
        priority: 10,
        trigger: {
          event: "completed",
          condition: { mode: "keyword", keywords: ["通过", "完成", "没问题", "达标", "通过✓"] },
        },
      },
      {
        // 兜底：测试完成但无明确关键词 → 默认交回组长
        id: "t6-tester-leader-fallback",
        from: "tester",
        to: "leader",
        priority: 0,
        trigger: { event: "completed", condition: { mode: "always" } },
      },
    ];

    const now = Date.now();
    return {
      sessionId,
      name,
      cwd,
      entryAgentId: "leader",
      agents,
      transitions,
      reworkEdges: [{ from: "tester", to: "developer" }],
      defaultRoutingMode: "hybrid",
      maxHops: 30,
      maxReworkRounds: 3,
      maxRunMinutes: 30,
      contextScope: "structured",
      recentCount: 20,
      createdAt: now,
      updatedAt: now,
    };
  },
};

export const TEAM_TEMPLATES: TeamTemplate[] = [SOFTWARE_DEV_TEMPLATE];

/** 用户自定义模板（数据快照，可被可视化编辑器编辑） */
export interface UserTemplate {
  id: string;
  name: string;
  description?: string;
  agents: AgentDef[];
  transitions: Transition[];
  gateways?: GatewayDef[];
  nodePositions?: Record<string, { x: number; y: number }>;
  entryAgentId: string;
  reworkEdges?: { from: string; to: string }[];
  defaultRoutingMode: RoutingMode;
  maxHops: number;
  maxReworkRounds: number;
  maxRunMinutes: number;
  contextScope: "structured" | "summary" | "recent";
  createdAt: number;
  updatedAt: number;
}

export function getTemplate(templateId: string): TeamTemplate | undefined {
  return TEAM_TEMPLATES.find((t) => t.id === templateId);
}

/** 创建一个团队配置。
 *  有模板 → 直接用模板；空团队但有 agentIds → 从库构建角色（leader 始终第一）；
 *  完全空 → 仅 leader。 */
export function createTeamDef(
  sessionId: string,
  cwd: string,
  name: string,
  templateId?: string,
  userTemplates?: UserTemplate[],
  agentIds?: string[],
): TeamDef {
  const template = templateId ? getTemplate(templateId) : undefined;
  if (template) return template.build(sessionId, cwd, name);

  // 用户自定义模板：数据快照深拷贝（sessionId/cwd/name 覆写）
  const userTpl = templateId ? (userTemplates ?? []).find((t) => t.id === templateId) : undefined;
  if (userTpl) {
    const now = Date.now();
    return {
      sessionId,
      name,
      cwd,
      entryAgentId: userTpl.entryAgentId,
      agents: userTpl.agents.map((a) => ({ ...a, toolNames: [...a.toolNames], ...(a.skillIds ? { skillIds: [...a.skillIds] } : {}) })),
      transitions: userTpl.transitions.map((t) => ({ ...t, trigger: { ...t.trigger, ...(t.trigger.condition ? { condition: { ...t.trigger.condition } } : {}) } })),
      gateways: userTpl.gateways?.map((g) => ({ ...g })),
      nodePositions: userTpl.nodePositions ? JSON.parse(JSON.stringify(userTpl.nodePositions)) : undefined,
      reworkEdges: userTpl.reworkEdges ? userTpl.reworkEdges.map((e) => ({ ...e })) : undefined,
      defaultRoutingMode: userTpl.defaultRoutingMode ?? "hybrid",
      maxHops: userTpl.maxHops ?? 30,
      maxReworkRounds: userTpl.maxReworkRounds ?? 3,
      maxRunMinutes: userTpl.maxRunMinutes ?? 30,
      contextScope: userTpl.contextScope ?? "structured",
      recentCount: 20,
      createdAt: now,
      updatedAt: now,
    };
  }

  const now = Date.now();
  // 空团队但指定了角色 → 从库构建（leader 始终第一）
  if (agentIds && agentIds.length > 0) {
    const ids = new Set<string>();
    ids.add("leader");
    for (const id of agentIds) ids.add(id);
    const agents = [...ids]
      .map((id) => BUILTIN_AGENTS.find((a) => a.id === id))
      .filter(Boolean)
      .map((a) => ({ ...agentFromLibrary(a!), workspace: { mode: "team" as const } }));
    return {
      sessionId,
      name,
      cwd,
      entryAgentId: "leader",
      agents,
      transitions: [],
      defaultRoutingMode: "hybrid",
      maxHops: 30,
      maxReworkRounds: 3,
      maxRunMinutes: 30,
      contextScope: "structured",
      recentCount: 20,
      createdAt: now,
      updatedAt: now,
    };
  }
  // 无模板、无角色选择 → 默认骨架（仅 leader）
  const leaderItem = BUILTIN_AGENTS.find((a) => a.id === "leader");
  const leader = leaderItem ? { ...agentFromLibrary(leaderItem), workspace: { mode: "team" as const } } : null;
  return {
    sessionId,
    name,
    cwd,
    entryAgentId: leader ? "leader" : "",
    agents: leader ? [leader] : [],
    transitions: [],
    defaultRoutingMode: "hybrid",
    maxHops: 30,
    maxReworkRounds: 3,
    maxRunMinutes: 30,
    contextScope: "structured",
    recentCount: 20,
    createdAt: now,
    updatedAt: now,
  };
}
