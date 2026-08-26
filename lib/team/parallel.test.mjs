/**
 * P0-3 真并行调度压力测试（mock 执行器，不依赖真实模型）。
 * 核心验证目标：
 *  - 并行分叉（parallel 网关）产生的多个分支在同一个波次里【真正并发】执行（用时间重叠证明，非累加）。
 *  - 并行分支落盘事件严格单调（execution_started/completed 串行、序列不重不漏）。
 *  - merge（AND-join）在所有入边到达后才释放一次，不重复回填、不提前。
 *  - 嵌套并行（并行分支内部再分叉→汇聚）正确处理。
 * 运行：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/team/parallel.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { RunManager, END_NODE } = await import("./runtime.ts");
const { EventStore } = await import("./store.ts");
const { reduce } = await import("./types.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-par-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
  return root;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 支持延迟的 mock 执行器：记录每次执行的 start/end（用于证明并发） */
function createDelayedExecutor(script) {
  const calls = [];
  return {
    calls,
    run: async ({ execution, onMessage }) => {
      const key = `${execution.agentId}#${execution.sequence}`;
      const entry = script[key];
      if (!entry) throw new Error(`no script for ${key}`);
      const start = Date.now();
      if (entry.delayMs) await sleep(entry.delayMs);
      calls.push({ agentId: execution.agentId, sequence: execution.sequence, start, end: Date.now() });
      onMessage({
        id: `msg-${execution.id}`,
        kind: "agent",
        executionId: execution.id,
        agentId: execution.agentId,
        role: execution.agentId,
        content: entry.output,
        createdAt: Date.now(),
      });
      return { status: entry.status ?? "completed", output: entry.output };
    },
  };
}

function baseAgents() {
  return [
    { id: "leader", name: "组长", emoji: "🧭", role: "组长", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
    { id: "coder", name: "开发", emoji: "👨‍💻", role: "开发", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
    { id: "tester", name: "测试", emoji: "🧪", role: "测试", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
    { id: "writer", name: "文档", emoji: "📝", role: "文档", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
    { id: "dev1", name: "开发A", emoji: "🅰️", role: "开发", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
    { id: "dev2", name: "开发B", emoji: "🅱️", role: "开发", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
  ];
}

function makeTeam({ transitions, gateways, entryAgentId = "leader", maxHops = 40 }) {
  const now = Date.now();
  return {
    sessionId: "sess-par",
    name: "并行测试",
    cwd: "/work",
    entryAgentId,
    agents: baseAgents(),
    transitions,
    gateways,
    defaultRoutingMode: "strict",
    maxHops,
    maxReworkRounds: 3,
    maxRunMinutes: 5,
    contextScope: "structured",
    recentCount: 20,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(task, runId = "run-1") {
  return {
    id: runId,
    teamId: "sess-par",
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

/** 判断两个时间区间是否重叠（>0 即重叠） */
function overlap(a, b) {
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

// ==================== 测试 1：真并发证明（时间重叠） ====================
test("P0-3 真并行：parallel 网关分叉的 3 个分支在时间上重叠执行（非累加串行）", async (t) => {
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
      always("t3", "gw-split", "writer"),
      always("t4", "coder", "gw-merge"),
      always("t5", "tester", "gw-merge"),
      always("t6", "writer", "gw-merge"),
      always("t7", "gw-merge", "leader"),
      { id: "t8", from: "leader", to: END_NODE, priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["收尾完成"] } }, enabled: true },
    ],
  });
  // 三个并行分支各自耗时 80ms：若串行累加则 ≥240ms；真并发则三者重叠在约 80ms 窗口内
  const DELAY = 80;
  const script = {
    "leader#1": { output: "开始并行" },
    "coder#1": { output: "开发完成", delayMs: DELAY },
    "tester#1": { output: "测试完成", delayMs: DELAY },
    "writer#1": { output: "文档完成", delayMs: DELAY },
    "leader#2": { output: "收尾完成，全部并行任务结束" },
  };
  const exec = createDelayedExecutor(script);
  const rm = new RunManager({ team, runId: "run-1", executor: exec });
  const final = await rm.execute(makeRun("并行压力测试"));

  assert.equal(final.status, "completed", `终态 ${final.status} ${final.statusReason?.message ?? ""}`);
  const coder = exec.calls.find((c) => c.agentId === "coder" && c.sequence === 1);
  const tester = exec.calls.find((c) => c.agentId === "tester" && c.sequence === 1);
  const writer = exec.calls.find((c) => c.agentId === "writer" && c.sequence === 1);
  assert.ok(coder && tester && writer, "三个并行分支都应执行");

  // 关键断言：任两个并行分支的执行区间重叠（证明真并发，而非分批累加）
  const pairs = [[coder, tester], [coder, writer], [tester, writer]];
  const overlapCount = pairs.filter(([a, b]) => overlap(a, b)).length;
  assert.ok(overlapCount >= 2, `3 个分支应两两重叠（实际重叠 ${overlapCount}/3）`);

  // 时长不至于累加到 3×DELAY：整个 run 的 max_end - min_start 应显著 < 2×DELAY（留裕量）
  const all = [coder, tester, writer];
  const minStart = Math.min(...all.map((c) => c.start));
  const maxEnd = Math.max(...all.map((c) => c.end));
  assert.ok(maxEnd - minStart < DELAY * 2, `3 分支应并发（实际窗口 ${maxEnd - minStart}ms，应 < ${DELAY * 2}ms）`);

  // 计数：leader = 2（初始 + 汇聚后收尾），coder/tester/writer = 1
  assert.equal(exec.calls.filter((c) => c.agentId === "leader").length, 2);
  assert.equal(exec.calls.filter((c) => c.agentId === "coder").length, 1);
  assert.equal(exec.calls.filter((c) => c.agentId === "tester").length, 1);
  assert.equal(exec.calls.filter((c) => c.agentId === "writer").length, 1);
});

// ==================== 测试 2：并行事件顺序单调 + 计数正确 + merge 只回填一次 ====================
test("P0-3 并行事件流：严格单调、execution 计数正确、merge 不重复回填", async (t) => {
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
      always("t3", "gw-split", "writer"),
      always("t4", "coder", "gw-merge"),
      always("t5", "tester", "gw-merge"),
      always("t6", "writer", "gw-merge"),
      always("t7", "gw-merge", "leader"),
      { id: "t8", from: "leader", to: END_NODE, priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["收尾完成"] } }, enabled: true },
    ],
  });
  const script = {
    "leader#1": { output: "开跑" },
    "coder#1": { output: "开发完成", delayMs: 5 },
    "tester#1": { output: "测试完成", delayMs: 3 },
    "writer#1": { output: "文档完成", delayMs: 7 },
    "leader#2": { output: "收尾完成，全部并行任务结束" },
  };
  const exec = createDelayedExecutor(script);
  const rm = new RunManager({ team, runId: "run-ev", executor: exec });
  const final = await rm.execute(makeRun("并行事件流"));

  assert.equal(final.status, "completed");

  const events = new EventStore("sess-par", "run-ev").replay();
  assert.equal(events[0].type, "run_started");
  assert.equal(events[events.length - 1].type, "run_completed");
  // 序列严格单调（并发写不重不漏）
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].sequence > events[i - 1].sequence, `第 ${i} 个事件序列应严格递增`);
  }

  // execution_started / execution_completed 配对且唯一
  const started = events.filter((e) => e.type === "execution_started");
  const completed = events.filter((e) => e.type === "execution_completed");
  assert.equal(started.length, 5, "应有 5 次执行（leader/coder/tester/writer/leader）");
  assert.equal(completed.length, 5, "5 次执行都完成");
  const startedIds = new Set(started.map((e) => e.execution.id));
  const completedIds = new Set(completed.map((e) => e.executionId));
  assert.deepEqual([...completedIds].sort(), [...startedIds].sort(), "completed 与 started 一一对应");

  // 投影：executions.length = 5
  const p = reduce(events);
  assert.equal(p.executions.length, 5);
  // merge 只回填一次 → leader 只会出现初始 + 汇合后共 2 次
  assert.equal(p.executions.filter((e) => e.agentId === "leader").length, 2);
  // lastHandoff 终点为 __end__
  assert.equal(p.state.lastHandoff?.to, END_NODE);
});

// ==================== 测试 3：嵌套并行（分支内再分叉→汇聚） ====================
test("P0-3 嵌套并行：并行分支内部再分叉并汇聚，execution 计数与 merge 正确", async (t) => {
  useTempDataDir(t);
  const team = makeTeam({
    gateways: [
      { id: "gw-split", type: "parallel", name: "外层并行" },
      { id: "gw-split2", type: "parallel", name: "内层并行" },
      { id: "gw-merge2", type: "merge", name: "内层汇聚" },
      { id: "gw-merge", type: "merge", name: "外层汇聚" },
    ],
    transitions: [
      always("t0", "leader", "gw-split"),
      always("t1", "gw-split", "coder"),
      always("t2", "gw-split", "tester"),
      // coder 分支内部再分叉
      always("t3", "coder", "gw-split2"),
      always("t4", "gw-split2", "dev1"),
      always("t5", "gw-split2", "dev2"),
      always("t6", "dev1", "gw-merge2"),
      always("t7", "dev2", "gw-merge2"),
      always("t8", "gw-merge2", "gw-merge"),
      // tester 分支直接到外层汇聚
      always("t9", "tester", "gw-merge"),
      always("t10", "gw-merge", "leader"),
      { id: "t11", from: "leader", to: END_NODE, priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["收尾完成"] } }, enabled: true },
    ],
  });
  const script = {
    "leader#1": { output: "开始" },
    "coder#1": { output: "拆成两块", delayMs: 2 },
    "dev1#1": { output: "开发块1完成", delayMs: 5 },
    "dev2#1": { output: "开发块2完成", delayMs: 5 },
    "tester#1": { output: "测试完成", delayMs: 5 },
    "leader#2": { output: "收尾完成，全部并行任务结束" },
  };
  const exec = createDelayedExecutor(script);
  const rm = new RunManager({ team, runId: "run-nest", executor: exec });
  const final = await rm.execute(makeRun("嵌套并行"));

  assert.equal(final.status, "completed", `终态 ${final.status} ${final.statusReason?.message ?? ""}`);
  // 期望执行：leader#1, coder#1, dev1#1, dev2#1, tester#1, leader#2 = 6 次
  assert.deepEqual(
    exec.calls.map((c) => `${c.agentId}#${c.sequence}`).sort(),
    ["coder#1", "dev1#1", "dev2#1", "leader#1", "leader#2", "tester#1"].sort(),
  );
  // 波次语义：同一深度/同一波次的分支真并发；不同深度分属不同波次（tester 比 dev 浅一个波次）。
  // 外层分叉分支 coder|tester 同波并发；内层分叉分支 dev1|dev2 同波并发。
  const coder = exec.calls.find((c) => c.agentId === "coder");
  const dev1 = exec.calls.find((c) => c.agentId === "dev1");
  const dev2 = exec.calls.find((c) => c.agentId === "dev2");
  const tester = exec.calls.find((c) => c.agentId === "tester");
  assert.ok(overlap(coder, tester), "外层并行分支(coder|tester)应重叠");
  assert.ok(overlap(dev1, dev2), "内层并行分支(dev1|dev2)应重叠");

  // 事件单调 + 6 次执行
  const events = new EventStore("sess-par", "run-nest").replay();
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].sequence > events[i - 1].sequence);
  }
  const p = reduce(events);
  assert.equal(p.executions.length, 6);
});

// ==================== 测试 4：并行 + 容错汇聚（缺分支合并推进） ====================
test("P0-3 并行容错：merge 缺分支（分支走别的路由）时容忍推进，不卡死", async (t) => {
  useTempDataDir(t);
  const team = makeTeam({
    gateways: [
      { id: "gw-split", type: "parallel", name: "并行" },
      { id: "gw-merge", type: "merge", name: "汇聚" },
    ],
    transitions: [
      always("t0", "leader", "gw-split"),
      always("t1", "gw-split", "coder"),
      always("t2", "gw-split", "tester"),
      // coder 走 __end__ 收尾；tester 走汇聚（其余分支缺失）
      { id: "t3", from: "coder", to: END_NODE, priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["全部完成"] } }, enabled: true },
      always("t4", "tester", "gw-merge"),
      always("t5", "gw-merge", "leader"),
      { id: "t6", from: "leader", to: END_NODE, priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["收尾完成"] } }, enabled: true },
    ],
  });
  const script = {
    "leader#1": { output: "开跑" },
    "coder#1": { output: "全部完成", delayMs: 5 },
    "tester#1": { output: "测试完成", delayMs: 5 },
    "leader#2": { output: "收尾完成" },
  };
  const exec = createDelayedExecutor(script);
  const rm = new RunManager({ team, runId: "run-tol", executor: exec });
  const final = await rm.execute(makeRun("并行容错"));

  assert.equal(final.status, "completed", `终态 ${final.status} ${final.statusReason?.message ?? ""}`);
  // gw-merge 入边 = tester + (期望)coder，但 coder 走了 __end__，缺分支 → 容错推进 → leader 收尾
  assert.ok(exec.calls.some((c) => c.agentId === "leader" && c.sequence === 2), "汇聚后 leader 应再次执行收尾");
  assert.ok(exec.calls.some((c) => c.agentId === "tester"), "tester 分支执行");
  const events = new EventStore("sess-par", "run-tol").replay();
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].sequence > events[i - 1].sequence);
  }
});
