/**
 * 项目组工作流「内置流程预设」（供「执行模式」档位复用）。
 *
 * 设计要点（按用户确认）：
 *  - 「团队模板」概念已删除 —— 设置里不再有模板库/模板导入下拉。
 *  - 执行模式在 **run 级** 生效：auto=按复杂度分流 / solo=单会话 / serial=串行 / parallel=并行 / custom=自定义画布。
 *  - serial（串行）复用 serialFlow() 内置边；parallel（并行）复用 parallelFlow() 内置网关+边。
 *    两者都在运行时按模式注入「有效团队视图」，**流程图设置里不显示**（只有 custom 才显示画布）。
 */
import type { AgentDef, GatewayDef, RoutingMode, Transition } from "./types.ts";
import type { TeamDef } from "./types.ts";
import { BUILTIN_AGENTS, agentFromLibrary } from "./library.ts";

/** 把库角色项转成 AgentDef（内置角色统一归团队 workspace）。 */
export function teamAgent(item: (typeof BUILTIN_AGENTS)[number]): AgentDef {
  return { ...agentFromLibrary(item), workspace: { mode: "team" } };
}

/** 内置串行工作流（serial 模式默认）：组长 → 产品 → 开发 → 测试；测试发现问题返工开发，通过后交回组长总结。 */
export function serialFlow(
  leaderId = "leader",
  productId = "product",
  developerId = "developer",
  testerId = "tester",
): Transition[] {
  return [
    { id: "t0-leader-end", from: leaderId, to: "__end__", priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["总结完成", "任务完成", "全部完成", "收尾完成", "结论：", "最终结论"] } } },
    { id: "t1-leader-product", from: leaderId, to: productId, priority: 0, onlyExecutionSeq: 1, trigger: { event: "completed", condition: { mode: "always" } } },
    { id: "t2-product-developer", from: productId, to: developerId, priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
    { id: "t3-developer-tester", from: developerId, to: testerId, priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
    { id: "t4-tester-developer-rework", from: testerId, to: developerId, priority: 20, verdictGuard: "fail", trigger: { event: "completed", condition: { mode: "keyword", keywords: ["问题", "失败", "bug", "BUG", "缺陷", "未通过", "不过", "不通过"] } } },
    { id: "t5-tester-leader-pass", from: testerId, to: leaderId, priority: 10, verdictGuard: "pass", trigger: { event: "completed", condition: { mode: "keyword", keywords: ["通过", "完成", "没问题", "达标", "通过✓"] } } },
    { id: "t6-tester-leader-fallback", from: testerId, to: leaderId, priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
  ];
}

/** 内置并行工作流（parallel 模式默认）：组长 → parallel 网关分叉(调研/开发/文档) → merge 汇聚 → 测试交叉验证 → 组长汇总。 */
export function parallelFlow(
  leaderId = "leader",
  researcherId = "researcher",
  developerId = "developer",
  writerId = "writer",
  testerId = "tester",
): { transitions: Transition[]; gateways: GatewayDef[] } {
  return {
    transitions: [
      { id: "s0-leader-end", from: leaderId, to: "__end__", priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["总结完成", "任务完成", "全部完成", "收尾完成", "最终结论", "结论："] } } },
      { id: "s1-leader-split", from: leaderId, to: "gw-split", priority: 0, onlyExecutionSeq: 1, trigger: { event: "completed", condition: { mode: "always" } } },
      { id: "s2-split-research", from: "gw-split", to: researcherId, priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
      { id: "s3-split-developer", from: "gw-split", to: developerId, priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
      { id: "s4-split-writer", from: "gw-split", to: writerId, priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
      { id: "s5-research-merge", from: researcherId, to: "gw-merge", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
      { id: "s6-developer-merge", from: developerId, to: "gw-merge", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
      { id: "s7-writer-merge", from: writerId, to: "gw-merge", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
      { id: "s8-merge-tester", from: "gw-merge", to: testerId, priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
      { id: "s9-tester-leader-pass", from: testerId, to: leaderId, priority: 30, verdictGuard: "pass", trigger: { event: "completed", condition: { mode: "keyword", keywords: ["通过", "达标", "完毕", "全部通过", "PASS"] } } },
      { id: "s10-tester-developer-rework", from: testerId, to: developerId, priority: 20, verdictGuard: "fail", trigger: { event: "completed", condition: { mode: "keyword", keywords: ["问题", "失败", "bug", "BUG", "缺陷", "未通过", "不通过", "不符合"] } } },
      { id: "s11-tester-leader-fallback", from: testerId, to: leaderId, priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
    ],
    gateways: [
      { id: "gw-split", type: "parallel", name: "并行分叉" },
      { id: "gw-merge", type: "merge", name: "汇聚" },
    ],
  };
}

/** 内置流程模板：software-dev=串行研发团队；solver=并行解题团队（验证用 getTemplate/build）。 */
export interface TeamTemplate {
  id: string;
  name: string;
  description?: string;
  build: (sessionId: string, cwd: string, name: string) => TeamDef;
}

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: "software-dev",
    name: "软件开发团队",
    description: "组长→产品→开发→测试 + 返工闭环",
    build: (sessionId, cwd, name) => createTeamDef(sessionId, cwd, name, "software-dev"),
  },
  {
    id: "solver",
    name: "并行解题团队",
    description: "组长并行分派(调研/开发/文档)→测试交叉验证→组长汇总",
    build: (sessionId, cwd, name) => createTeamDef(sessionId, cwd, name, "solver"),
  },
];

export function getTemplate(templateId: string): TeamTemplate | undefined {
  return TEAM_TEMPLATES.find((t) => t.id === templateId);
}

/**
 * 创建一个团队配置。
 *  - 默认（无模板选择）：内置全部角色（leader/product/developer/tester/researcher/writer）+
 *    串行默认边 —— 一键创建即有完整多角色与可执行工作流（符合用户「创建后默认加全部内置角色」）。
 *  - 保留 _templateId/_userTemplates/_agentIds 参数签名以兼容旧调用方（忽略；模板概念已删）。
 *  - 执行模式/流程在 run 级选择，不在此固化。
 */
export function createTeamDef(
  sessionId: string,
  cwd: string,
  name: string,
  templateId?: string,
  _userTemplates?: unknown[],
  _agentIds?: string[],
): TeamDef {
  const now = Date.now();
  const base = {
    sessionId,
    name,
    cwd,
    entryAgentId: "leader",
    /** 默认「系统判断」：一键创建即有完整多角色，但流程图画布不显示（仅 custom 才展示） */
    executionMode: "auto" as const,
    defaultRoutingMode: "hybrid" as RoutingMode,
    maxHops: 30,
    maxReworkRounds: 3,
    maxRunMinutes: 60,
    contextScope: "structured" as const,
    recentCount: 20,
    createdAt: now,
    updatedAt: now,
  };
  // 预置模板：software-dev → 串行团队（组长/产品/开发/测试）；solver → 并行团队（组长/调研/开发/文档/测试）
  if (templateId === "solver") {
    const agents = ["leader", "researcher", "developer", "writer", "tester"]
      .map((id) => BUILTIN_AGENTS.find((a) => a.id === id))
      .filter((a): a is (typeof BUILTIN_AGENTS)[number] => Boolean(a))
      .map((a) => teamAgent(a));
    const flow = parallelFlow();
    return {
      ...base,
      agents,
      transitions: flow.transitions,
      gateways: flow.gateways,
      reworkEdges: [{ from: "tester", to: "developer" }],
    };
  }
  if (templateId === "software-dev") {
    const agents = ["leader", "product", "developer", "tester"]
      .map((id) => BUILTIN_AGENTS.find((a) => a.id === id))
      .filter((a): a is (typeof BUILTIN_AGENTS)[number] => Boolean(a))
      .map((a) => teamAgent(a));
    return {
      ...base,
      agents,
      transitions: serialFlow(),
      reworkEdges: [{ from: "tester", to: "developer" }],
    };
  }
  // 默认：全量内置角色 + 串行默认边（一键创建即有完整多角色，可再切 executionMode 或自定义画布）
  const agents: AgentDef[] = BUILTIN_AGENTS.map((a) => teamAgent(a));
  return {
    ...base,
    agents,
    transitions: serialFlow(),
    reworkEdges: [{ from: "tester", to: "developer" }],
  };
}