import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 直接引入引擎层（不走 Next bundler）—— 验证 executionMode → 有效团队视图 / 复杂度 / 实际执行链
const { startTeamRun, readRunDetail } = await import("./registry.ts");
const { createTeamDef } = await import("./templates.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-exec-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); delete process.env.PI_WEB_UPLOADS_DIR; });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 记录每个 agent 实际执行序号，按脚本应答；verdict 用于返工边判定 */
function makeExecutor(script, log) {
  return {
    run: async ({ execution, mode, onMessage }) => {
      const key = `${execution.agentId}#${execution.sequence}`;
      const e = script[key];
      if (!e) throw new Error("no script: " + key);
      if (e.delayMs) await sleep(e.delayMs);
      log.push(`${key}|mode=${mode}|seq=${execution.sequence}`);
      onMessage({
        id: `m-${execution.id}`, kind: "agent", executionId: execution.id,
        agentId: execution.agentId, role: execution.agentId, content: e.output, createdAt: Date.now(),
      });
      return { status: "completed", output: e.output, ...(e.verdict ? { verdict: e.verdict } : {}) };
    },
  };
}

// 串行脚本：leader 拆解 → 产品 → 开发 → 测试 pass → leader 汇总 → 结束
const SERIAL = {
  "leader#1": { output: "拆解：需求→设计→实现→验证" },
  "product#1": { output: "需求文档完成" },
  "developer#1": { output: "实现完成" },
  "tester#1": { output: "全部通过", verdict: "pass" },
  "leader#2": { output: "总结完成：最终结论：串行链路全绿" },
};
// 并行脚本：leader 拆解 → 分叉(调研/开发/文档) → merge → 测试 pass → leader 汇总
const PARALLEL = {
  "leader#1": { output: "拆解：并行调研+开发+文档" },
  "researcher#1": { output: "调研结论", delayMs: 20 },
  "developer#1": { output: "实现完成", delayMs: 20 },
  "writer#1": { output: "文档完成", delayMs: 20 },
  "tester#1": { output: "全部通过", verdict: "pass" },
  "leader#2": { output: "总结完成：最终结论：并行全绿" },
};
const SOLO = {
  "leader#1": { output: "已直接完成单点任务：加背景" },
};

// 等 run 结束（轮询 run 状态到终态）
async function waitDone(sessionId, runId, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { run } = readRunDetail(sessionId, runId);
    if (run.status !== "running" && run.status !== "pending") return run;
    await sleep(30);
  }
  throw new Error("run 未在限时内结束: " + runId);
}

test("executionMode: auto(简单任务) → simple + solo 单会话", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-auto", "/w", "t");
  team.executionMode = "auto";
  const log = [];
  const { runId } = startTeamRun(team, "加一个动态背景", undefined, undefined, makeExecutor(SOLO, log));
  const run = await waitDone(team.sessionId, runId);
  assert.equal(run.complexity, "simple", "simple 任务 auto → complexity=simple");
  assert.equal(run.status, "completed");
  assert.deepEqual(log.map((l) => l.split("|")[0]), ["leader#1"], "auto(simple) 只跑入口");
  assert.ok(log[0].includes("mode=solo"), "入口以 solo 模式运行");
});

test("executionMode: solo → 强制 simple（即使任务看起来 complex）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-solo", "/w", "t");
  const complexTask = "搭建一个多模块内容管理平台"; // classify 为 complex
  const log = [];
  const { runId } = startTeamRun(team, complexTask, "solo", undefined, makeExecutor(SOLO, log));
  const run = await waitDone(team.sessionId, runId);
  assert.equal(run.complexity, "simple", "solo 强制 simple");
  assert.deepEqual(log.map((l) => l.split("|")[0]), ["leader#1"]);
  assert.ok(log[0].includes("mode=solo"));
});

test("executionMode: serial → 强制 complex + 串行链路（leader→product→developer→tester→leader）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-serial", "/w", "t");
  const log = [];
  const { runId } = startTeamRun(team, "任意任务", "serial", undefined, makeExecutor(SERIAL, log));
  const run = await waitDone(team.sessionId, runId);
  assert.equal(run.complexity, "complex", "serial 强制 complex（不被 solo 短路）");
  assert.equal(run.status, "completed");
  const chain = log.map((l) => l.split("|")[0]);
  assert.deepEqual(chain, ["leader#1", "product#1", "developer#1", "tester#1", "leader#2"], "serial 走串行边链");
  assert.ok(log.mode || (log.every((l) => l.includes("mode=orchestrated"))), "串行角色以 orchestrated 运行");
});

test("executionMode: parallel → 强制 complex + 并行网关（分叉真并发 + merge）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-para", "/w", "t");
  const log = []; const stamps = {};
  const executor = { run: async ({ execution, mode, onMessage }) => {
    const key = `${execution.agentId}#${execution.sequence}`;
    const e = PARALLEL[key]; if (!e) throw new Error("no script " + key);
    const start = Date.now();
    if (e.delayMs) await sleep(e.delayMs);
    stamps[key] = [start, Date.now()];
    log.push(`${key}|mode=${mode}`);
    onMessage({ id: `m-${execution.id}`, kind: "agent", executionId: execution.id, agentId: execution.agentId, role: execution.agentId, content: e.output, createdAt: Date.now() });
    return { status: "completed", output: e.output, ...(e.verdict ? { verdict: e.verdict } : {}) };
  }};
  const overlap = (a, b) => Math.max(a[0], b[0]) < Math.min(a[1], b[1]);
  const { runId } = startTeamRun(team, "多模块平台", "parallel", undefined, executor);
  const run = await waitDone(team.sessionId, runId);
  assert.equal(run.complexity, "complex");
  assert.equal(run.status, "completed");
  const chain = log.map((l) => l.split("|")[0]);
  assert.deepEqual(chain, ["leader#1", "researcher#1", "developer#1", "writer#1", "tester#1", "leader#2"], "parallel 经网关分叉/汇聚");
  assert.ok(overlap(stamps["researcher#1"], stamps["developer#1"]), "分叉分支应真并发（时间重叠）");
});

test("executionMode: custom → 使用团队自绘 transitions（原样）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-custom", "/w", "t");
  // 只保留 组长→开发→组长 的自绘流程
  team.transitions = [
    { id: "c0", from: "leader", to: "developer", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, onlyExecutionSeq: 1 },
    { id: "c1", from: "developer", to: "leader", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
    { id: "c2", from: "leader", to: "__end__", priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["总结完成", "最终结论"] } } },
  ];
  const log = [];
  const script = {
    "leader#1": { output: "拆解" },
    "developer#1": { output: "开发完成" },
    "leader#2": { output: "总结完成：最终结论：自定义流程跑通" },
  };
  const { runId } = startTeamRun(team, "自定义任务", "custom", undefined, makeExecutor(script, log));
  const run = await waitDone(team.sessionId, runId);
  assert.equal(run.complexity, "complex", "custom 强制 complex（走用户流程）");
  const chain = log.map((l) => l.split("|")[0]);
  assert.deepEqual(chain, ["leader#1", "developer#1", "leader#2"], "custom 使用用户自绘边，不走内置 serial");
  assert.ok(!log.some((l) => l.split("|")[0].startsWith("product")), "custom 不引入 product 角色");
});
