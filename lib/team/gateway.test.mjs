/**
 * 网关节点执行测试（Phase 1C §10.2 网关）：mock 执行器，不依赖真实模型。
 *  - exclusive：条件命中选一条分支
 *  - parallel：所有出边分支都执行
 *  - merge：所有入边到达后才继续（等待 + 容错推进）
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/gateway.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { RunManager } = await import("./runtime.ts");
const { EventStore } = await import("./store.ts");
const { reduce } = await import("./types.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-gw-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
  return root;
}

function createMockExecutor(script) {
  const calls = [];
  return {
    calls,
    run: async ({ execution, onMessage }) => {
      calls.push({ agentId: execution.agentId, sequence: execution.sequence });
      const key = `${execution.agentId}#${execution.sequence}`;
      const entry = script[key];
      if (!entry) throw new Error(`no script for ${key}`);
      onMessage({
        id: `msg-${execution.id}`,
        kind: "agent",
        executionId: execution.id,
        agentId: execution.agentId,
        role: execution.agentId,
        content: entry.output,
        createdAt: Date.now(),
      });
      return { status: entry.status ?? "completed", output: entry.output, failureReason: entry.failureReason };
    },
  };
}

const now = Date.now();
const baseAgents = [
  { id: "leader", name: "组长", emoji: "🧭", role: "项目组长", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
  { id: "coder", name: "开发", emoji: "👨‍💻", role: "开发", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
  { id: "tester", name: "测试", emoji: "🧪", role: "测试", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
  { id: "writer", name: "文档", emoji: "📝", role: "文档撰写", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
];

function makeTeam({ transitions, gateways, entryAgentId = "leader" }) {
  return {
    sessionId: "sess-gw",
    name: "网关测试",
    cwd: "/work",
    entryAgentId,
    agents: baseAgents,
    transitions,
    gateways,
    defaultRoutingMode: "strict",
    maxHops: 30,
    maxReworkRounds: 3,
    maxRunMinutes: 5,
    contextScope: "structured",
    recentCount: 20,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(task) {
  return {
    id: "run-1",
    teamId: "sess-gw",
    status: "pending",
    task,
    stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const always = (id, from, to, priority = 0) => ({
  id, from, to, priority,
  trigger: { event: "completed", condition: { mode: "always" } },
  enabled: true,
});

/** 测试 1：exclusive 网关命中「开发」关键词 → 只走开发分支 */
test("网关 exclusive：关键词命中走对应分支", async (t) => {
  useTempDataDir(t);
  const team = makeTeam({
    gateways: [{ id: "gw-decision", type: "exclusive", name: "条件分支" }],
    transitions: [
      always("t0", "leader", "gw-decision"),
      { id: "t1", from: "gw-decision", to: "coder", priority: 10, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["开发"] } }, enabled: true },
      { id: "t2", from: "gw-decision", to: "tester", priority: 5, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["测试"] } }, enabled: true },
      always("t3", "gw-decision", "writer"),
      always("t4", "coder", "__end__"),
      always("t5", "tester", "__end__"),
      always("t6", "writer", "__end__"),
    ],
  });
  const script = {
    "leader#1": { output: "先做开发实现" },
    "coder#1": { output: "开发完成" },
  };
  const exec = createMockExecutor(script);
  const rm = new RunManager({ team, runId: "run-1", executor: exec });
  const final = await rm.execute(makeRun("网关排他测试"));
  assert.equal(final.status, "completed", `终态应为 completed，实际 ${final.status} ${final.statusReason?.message}`);
  assert.deepEqual(exec.calls.map((c) => c.agentId), ["leader", "coder"], "只应执行 leader → coder");
});

/** 测试 2：exclusive 无关键词命中 → 走 always 兜底分支 */
test("网关 exclusive：无命中走 always 兜底", async (t) => {
  useTempDataDir(t);
  const team = makeTeam({
    gateways: [{ id: "gw-decision", type: "exclusive", name: "条件分支" }],
    transitions: [
      always("t0", "leader", "gw-decision"),
      { id: "t1", from: "gw-decision", to: "coder", priority: 10, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["开发"] } }, enabled: true },
      { id: "t2", from: "gw-decision", to: "tester", priority: 5, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["测试"] } }, enabled: true },
      always("t3", "gw-decision", "writer"),
      always("t4", "coder", "__end__"),
      always("t5", "tester", "__end__"),
      always("t6", "writer", "__end__"),
    ],
  });
  const script = {
    "leader#1": { output: "任务完成，写文档吧" },
    "writer#1": { output: "文档完成" },
  };
  const exec = createMockExecutor(script);
  const rm = new RunManager({ team, runId: "run-1", executor: exec });
  const final = await rm.execute(makeRun("排他兜底测试"));
  assert.equal(final.status, "completed", `终态 ${final.status} ${final.statusReason?.message}`);
  assert.deepEqual(exec.calls.map((c) => c.agentId), ["leader", "writer"], "应走 writer 兜底分支");
});

/** 测试 3：parallel 分叉 + merge 汇聚（两个分支都执行，汇聚后才收尾） */
test("网关 parallel + merge：两个分支都执行并汇聚", async (t) => {
  useTempDataDir(t);
  const team = makeTeam({
    gateways: [
      { id: "gw-split", type: "parallel", name: "并行分叉" },
      { id: "gw-merge", type: "merge", name: "汇聚" },
    ],
    transitions: [
      always("t0", "leader", "gw-split"),
      always("t1", "gw-split", "coder"),
      always("t2", "gw-split", "tester"),
      always("t3", "coder", "gw-merge"),
      always("t4", "tester", "gw-merge"),
      always("t5", "gw-merge", "leader"),
      { id: "t6", from: "leader", to: "__end__", priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["收尾完成"] } }, enabled: true },
    ],
  });
  const script = {
    "leader#1": { output: "开始并行执行" },
    "coder#1": { output: "开发完成" },
    "tester#1": { output: "测试完成" },
    "leader#2": { output: "收尾完成，全部并行任务结束" },
  };
  const exec = createMockExecutor(script);
  const rm = new RunManager({ team, runId: "run-1", executor: exec });
  const final = await rm.execute(makeRun("并行汇聚测试"));
  assert.equal(final.status, "completed", `终态 ${final.status} ${final.statusReason?.message}`);
  // 并行分支顺序由栈决定（LIFO），只断言执行集合与次数
  const ids = exec.calls.map((c) => c.agentId);
  assert.equal(ids.filter((x) => x === "leader").length, 2, "leader 执行 2 次（初始+收尾）");
  assert.equal(ids.filter((x) => x === "coder").length, 1, "coder 分支执行 1 次");
  assert.equal(ids.filter((x) => x === "tester").length, 1, "tester 分支执行 1 次");
});

/** 测试 4：merge 容错——exclusive 只走一条分支到汇聚，缺分支时自动推进 */
test("网关 merge 容错：分支缺失（exclusive 只走一路）自动推进", async (t) => {
  useTempDataDir(t);
  const team = makeTeam({
    gateways: [
      { id: "gw-decision", type: "exclusive", name: "条件分支" },
      { id: "gw-merge", type: "merge", name: "汇聚" },
    ],
    transitions: [
      always("t0", "leader", "gw-decision"),
      { id: "t1", from: "gw-decision", to: "coder", priority: 10, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["开发"] } }, enabled: true },
      always("t2", "gw-decision", "tester"),
      always("t3", "coder", "gw-merge"),
      always("t4", "tester", "gw-merge"),
      always("t5", "gw-merge", "leader"),
      { id: "t6", from: "leader", to: "__end__", priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["收尾完成"] } }, enabled: true },
    ],
  });
  const script = {
    "leader#1": { output: "直接开发" },
    "coder#1": { output: "开发完成" },
    "leader#2": { output: "收尾完成" },
  };
  const exec = createMockExecutor(script);
  const rm = new RunManager({ team, runId: "run-1", executor: exec });
  const final = await rm.execute(makeRun("merge 容错测试"));
  assert.equal(final.status, "completed", `终态 ${final.status} ${final.statusReason?.message}`);
  assert.deepEqual(exec.calls.map((c) => c.agentId), ["leader", "coder", "leader"], "exclusive 只走 coder，merge 容错推进");
});

/** 测试 5：inclusive 网关——命中条件的出边全走 */
test("网关 inclusive：命中条件的出边全部执行", async (t) => {
  useTempDataDir(t);
  const team = makeTeam({
    gateways: [{ id: "gw-incl", type: "inclusive", name: "包容分支" }],
    transitions: [
      always("t0", "leader", "gw-incl"),
      { id: "t1", from: "gw-incl", to: "coder", priority: 10, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["开发"] } }, enabled: true },
      { id: "t2", from: "gw-incl", to: "tester", priority: 5, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["测试"] } }, enabled: true },
      { id: "t3", from: "gw-incl", to: "writer", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      always("t4", "coder", "__end__"),
      always("t5", "tester", "__end__"),
      always("t6", "writer", "__end__"),
    ],
  });
  const script = {
    "leader#1": { output: "开发并测试" },
    "coder#1": { output: "开发完成" },
    "tester#1": { output: "测试完成" },
    "writer#1": { output: "文档完成" },
  };
  const exec = createMockExecutor(script);
  const rm = new RunManager({ team, runId: "run-1", executor: exec });
  const final = await rm.execute(makeRun("包容分支测试"));
  assert.equal(final.status, "completed", `终态 ${final.status} ${final.statusReason?.message}`);
  const ids = exec.calls.map((c) => c.agentId);
  assert.ok(ids.includes("coder"), "开发分支应命中");
  assert.ok(ids.includes("tester"), "测试分支应命中");
  assert.ok(ids.includes("writer"), "always 兜底分支应走");
});

/** 测试 6：事件流完整性——网关运行的事件仍单调完整 */
test("网关运行事件流完整（run_started / execution / run_completed）", async (t) => {
  useTempDataDir(t);
  const team = makeTeam({
    gateways: [{ id: "gw-split", type: "parallel", name: "并行" }],
    transitions: [
      always("t0", "leader", "gw-split"),
      always("t1", "gw-split", "coder"),
      always("t2", "gw-split", "tester"),
      always("t3", "coder", "__end__"),
      always("t4", "tester", "__end__"),
    ],
  });
  const script = {
    "leader#1": { output: "开跑" },
    "coder#1": { output: "完成" },
    "tester#1": { output: "完成" },
  };
  const exec = createMockExecutor(script);
  const rm = new RunManager({ team, runId: "run-1", executor: exec });
  const final = await rm.execute(makeRun("事件流测试"));
  assert.equal(final.status, "completed");
  const events = new EventStore("sess-gw", "run-1").replay();
  assert.equal(events[0].type, "run_started");
  assert.ok(events.some((e) => e.type === "run_completed"));
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].sequence > events[i - 1].sequence, "序列应单调递增");
  }
  const p = reduce(events);
  assert.equal(p.executions.length, 3, "3 次执行（leader/coder/tester）");
});
