/**
 * Phase 1A Step5 验证：WorkflowEngine 路由判定 + validate 静态校验。
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/engine.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { validateWorkflow, findCycle, stripNoise } = await import("./validate.ts");
const { WorkflowEngine, judgeCheap } = await import("./engine.ts");
const { createTeamDef } = await import("./templates.ts");
const { getTemplate } = await import("./templates.ts");

const TEAM = createTeamDef("s-1", "/work", "t", "software-dev");

// ==================== validate ====================

test("validate: software-dev 模板通过", () => {
  const r = validateWorkflow(TEAM);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);
});

test("validate: 边指向不存在 agent / entry 缺失 / 自环 → error", () => {
  const broken = {
    ...TEAM,
    entryAgentId: "ghost",
    agents: [TEAM.agents[0]],
    transitions: [
      { id: "t1", from: "leader", to: "ghost", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
      { id: "t2", from: "leader", to: "leader", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
      { id: "t3", from: "leader", to: "product", priority: 0, trigger: { event: "completed", condition: { mode: "keyword" } } }, // keyword 无关键词
    ],
  };
  const r = validateWorkflow(broken);
  assert.equal(r.valid, false);
  const codes = r.errors.map((e) => e.code);
  assert.ok(codes.includes("entry_agent_missing"));
  assert.ok(codes.includes("transition_target_missing"));
  assert.ok(codes.includes("self_loop"));
  assert.ok(codes.includes("condition_invalid"));
});

test("validate: 不可达 agent → warning（custom 模式）", () => {
  const t = getTemplate("software-dev");
  const team = t.build("s", "/w", "n");
  team.executionMode = "custom";
  team.agents.push({ id: "writer", name: "文档", role: "文档", model: "", systemPrompt: "", toolNames: [] });
  const r = validateWorkflow(team);
  const warnings = r.warnings.map((w) => w.code);
  assert.ok(warnings.includes("unreachable"));
  assert.equal(r.valid, true);
});

test("validate: 非 custom 模式不报结构质量警告（预设流/动态派活）", () => {
  // 全量内置角色 + serialFlow 预设，默认 executionMode=auto：
  // 未连边角色可被动态派活，返工环与多条优先级边为设计如此，不应产生误导性警告。
  const team = createTeamDef("s-x", "/work", "t");
  const r = validateWorkflow(team);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
  // 手动切到 custom 后会复现这些警告（角色确实未连边 / 含返工环 / 多条优先级边）
  const custom = { ...team, executionMode: "custom" };
  const rc = validateWorkflow(custom);
  const codes = rc.warnings.map((w) => w.code);
  assert.ok(codes.includes("unreachable"));
  assert.ok(codes.includes("cycle"));
  assert.ok(codes.includes("priority_overlap"));
});

test("validate: 环检测", () => {
  const g = new Map([
    ["a", ["b"]],
    ["b", ["c"]],
    ["c", ["a"]],
  ]);
  const cycle = findCycle({ ...TEAM, agents: [{ id: "a", name: "a", role: "", model: "", systemPrompt: "", toolNames: [] }, { id: "b", name: "b", role: "", model: "", systemPrompt: "", toolNames: [] }, { id: "c", name: "c", role: "", model: "", systemPrompt: "", toolNames: [] }] }, g);
  assert.equal(cycle.length, 3);
  assert.equal(cycle.join("->"), "a->b->c");
});

test("stripNoise: 屏蔽代码块与引用块", () => {
  const out = "问题如下：\n```\nif (x) { console.log('bug') }\n```\n> 引用：失败\n结论：已通过";
  const clean = stripNoise(out);
  assert.ok(!clean.includes("bug"));
  assert.ok(!clean.includes("失败"));
  assert.ok(clean.includes("通过"));
});

// ==================== engine ====================

test("engine: handoff 优先于 Transition（hybrid）", async () => {
  const engine = new WorkflowEngine(TEAM);
  const route = await engine.resolveRoute(
    { agentId: "tester", status: "completed" },
    {
      status: "completed",
      output: "发现 bug",
      handoffTool: { to: "developer", summary: "修复问题" },
    },
  );
  assert.equal(route?.kind, "tool");
  assert.equal(route?.to, "developer");
});

test("engine: strict 模式忽略 handoff 工具，只走 Transition", async () => {
  const team = { ...TEAM, defaultRoutingMode: "strict" };
  const engine = new WorkflowEngine(team);
  const route = await engine.resolveRoute(
    { agentId: "tester", status: "completed" },
    {
      status: "completed",
      output: "发现 bug",
      handoffTool: { to: "developer", summary: "修复" },
    },
  );
  // 输出含 "bug" → keyword 边 t4 命中（Transition 优先于工具，strict 忽略工具）
  assert.equal(route?.kind, "transition");
  assert.equal(route?.to, "developer");
  assert.equal(route?.transitionId, "t4-tester-developer-rework");
});

test("engine: keyword 命中 + priority DESC（返工边优先于兜底）", async () => {
  const engine = new WorkflowEngine(TEAM);
  // 测试输出含"问题" → t4(priority 20) 命中，不走 t6 always(0)
  const r1 = await engine.resolveRoute(
    { agentId: "tester", status: "completed" },
    { status: "completed", output: "验收发现 2 个问题" },
  );
  assert.equal(r1?.to, "developer");

  // 输出含"通过" → t5(priority 10) 命中
  const r2 = await engine.resolveRoute(
    { agentId: "tester", status: "completed" },
    { status: "completed", output: "全部测试通过" },
  );
  assert.equal(r2?.to, "leader");

  // 输出无关键词 → t6 always(0) 兜底
  const r3 = await engine.resolveRoute(
    { agentId: "tester", status: "completed" },
    { status: "completed", output: "例行检查完毕" },
  );
  assert.equal(r3?.to, "leader");
});

test("engine: rejectKeywords 优先于 keywords", async () => {
  const team = {
    ...TEAM,
    agents: [TEAM.agents[0]], // 只有 leader
    transitions: [
      { id: "tx", from: "leader", to: "product", priority: 5, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["完成"], rejectKeywords: ["未完成"] } } },
    ],
  };
  const engine = new WorkflowEngine(team);
  // 输出含"完成"但含"未完成" → reject 优先，不命中 → 无其他边 → null
  const r = await engine.resolveRoute(
    { agentId: "leader", status: "completed" },
    { status: "completed", output: "任务未完成" },
  );
  assert.equal(r, null);
  // 输出含"完成"且不含"未完成" → 命中
  const r2 = await engine.resolveRoute(
    { agentId: "leader", status: "completed" },
    { status: "completed", output: "任务完成，无遗留" },
  );
  assert.equal(r2?.transitionId, "tx");
});

test("engine: event 匹配（failed 事件）", async () => {
  const team = { ...TEAM, transitions: [
    { id: "e1", from: "developer", to: "leader", priority: 0, trigger: { event: "failed", condition: { mode: "always" } } },
  ] };
  const engine = new WorkflowEngine(team);
  const r = await engine.resolveRoute(
    { agentId: "developer", status: "failed" },
    { status: "failed", output: "编译失败", failureReason: "tsc error" },
  );
  assert.equal(r?.to, "leader");
});

test("engine: LLM judge 最后决策器，只调一次", async () => {
  const team = {
    ...TEAM,
    agents: [TEAM.agents[1]], // 只有 product
    transitions: [
      { id: "l1", from: "product", to: "developer", priority: 10, trigger: { event: "completed", condition: { mode: "llm", conditionText: "方案明确则实现" } } },
      { id: "l2", from: "product", to: "researcher", priority: 5, trigger: { event: "completed", condition: { mode: "llm", conditionText: "需调研则研究" } } },
    ],
  };
  let calls = 0;
  const engine = new WorkflowEngine(team, async (candidates) => {
    calls++;
    assert.equal(candidates.length, 2);
    return candidates.find((c) => c.transition.id === "l1")?.transition ?? null;
  });
  const r = await engine.resolveRoute(
    { agentId: "product", status: "completed" },
    { status: "completed", output: "方案已明确" },
  );
  assert.equal(r?.to, "developer");
  assert.equal(calls, 1);
});

test("engine: 未注入 llmJudge 时 llm 条件安全降级（不命中）", async () => {
  const team = {
    ...TEAM,
    agents: [TEAM.agents[1]], // 只有 product
    transitions: [{ id: "l1", from: "product", to: "developer", priority: 10, trigger: { event: "completed", condition: { mode: "llm", conditionText: "x" } } }],
  };
  const engine = new WorkflowEngine(team); // 无 judge
  const r = await engine.resolveRoute(
    { agentId: "product", status: "completed" },
    { status: "completed", output: "any" },
  );
  assert.equal(r, null);
});

test("judgeCheap: always 恒真 / keyword 匹配", () => {
  assert.equal(judgeCheap({ mode: "always" }, "anything"), true);
  assert.equal(judgeCheap(undefined, "anything"), true);
  assert.equal(judgeCheap({ mode: "keyword", keywords: ["bug", "问题"] }, "发现一个 BUG"), true);
  assert.equal(judgeCheap({ mode: "keyword", keywords: ["bug"] }, "一切正常"), false);
});
