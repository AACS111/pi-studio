import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { RunManager } = await import("./runtime.ts");
const { createTeamDef } = await import("./templates.ts");
const { classifyTask } = await import("./task-classify.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-full-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); delete process.env.PI_WEB_UPLOADS_DIR; });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function overlap(a, b) { return Math.max(a.start, b.start) < Math.min(a.end, b.end); }
function makeRun(team, task) {
  return { id: `run-${Date.now()}`, teamId: team.sessionId, status: "pending", task, complexity: classifyTask(task),
    stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 }, createdAt: Date.now(), updatedAt: Date.now() };
}

// A) solo 路径：单点功能任务（用户“加动态背景”场景）
test("E2E: solo 路径 —— 单点功能任务判 simple，入口角色以 solo 跑 1 次收尾", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-solo", "/w", "t", "software-dev");
  const task = "参考 DeepSeek Harness 官网生成对应的动态背景效果";
  assert.equal(classifyTask(task), "simple", "单点功能任务应判为 simple(solo)");

  const calls = []; const modes = []; const events = [];
  const executor = { run: async ({ execution, mode, onMessage }) => {
    calls.push(`${execution.agentId}#${execution.sequence}`); modes.push(mode);
    const content = mode === "solo" ? "已按需求完成动态背景：支持开关/多样式/强度/飘动" : "拆解";
    onMessage({ id: `m-${execution.id}`, kind: "agent", executionId: execution.id, agentId: execution.agentId, role: execution.agentId, content, createdAt: Date.now() });
    return { status: "completed", output: content };
  }};
  const rm = new RunManager({ team, runId: "run-solo-1", executor, onEvent: (e) => events.push(e) });
  const run = await rm.execute(makeRun(team, task));

  assert.equal(run.status, "completed", "solo 应 completed");
  assert.equal(modes[0], "solo", "入口应以 solo 模式运行");
  assert.deepEqual(calls, ["leader#1"], "solo 应只跑入口角色 1 次");
  const evTypes = events.map((e) => e.type);
  for (const et of ["run_started", "task_created", "execution_started", "execution_completed", "run_completed"])
    assert.ok(evTypes.includes(et), `solo 事件流应含 ${et}`);
});

// B) 并行编排路径：多模块大任务
test("E2E: 并行编排路径 —— 多模块任务 parallel 分叉真并发 → merge → 测试 pass → 组长汇总", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-para", "/w", "t", "solver");
  const task = "搭建一个多模块内容管理平台";
  assert.equal(classifyTask(task), "complex", "多模块平台应判为 complex(编排)");

  const calls = []; const modes = []; const events = [];
  const executor = { run: async ({ execution, mode, onMessage }) => {
    const start = Date.now(); const key = `${execution.agentId}#${execution.sequence}`;
    const script = {
      "leader#1": { output: "拆解：并行调研+开发+文档", delayMs: 0 },
      "researcher#1": { output: "调研结论：方案可行", delayMs: 50 },
      "developer#1": { output: "实现完成", delayMs: 50 },
      "writer#1": { output: "文档完成", delayMs: 50 },
      "tester#1": { output: "交叉验证通过", verdict: "pass", delayMs: 0 },
      "leader#2": { output: "总结完成：最终结论：多模块平台全部完成", delayMs: 0 },
    };
    const e = script[key]; if (!e) throw new Error("no script " + key);
    if (e.delayMs) await sleep(e.delayMs);
    calls.push(`${execution.agentId}#${execution.sequence}|${start}-${Date.now()}`); modes.push(mode);
    onMessage({ id: `m-${execution.id}`, kind: "agent", executionId: execution.id, agentId: execution.agentId, role: execution.agentId, content: e.output, createdAt: Date.now() });
    return { status: "completed", output: e.output, ...(e.verdict ? { verdict: e.verdict } : {}) };
  }};
  const rm = new RunManager({ team, runId: "run-para-1", executor, onEvent: (e) => events.push(e) });
  const run = await rm.execute(makeRun(team, task));

  const order = calls.map((c) => c.split("|")[0]);
  const leaderCount = order.filter((c) => c.startsWith("leader")).length;
  assert.equal(run.status, "completed", "并行编排应 completed");
  assert.equal(modes[0], "orchestrated", "入口应以 orchestrated 模式运行");
  assert.equal(leaderCount, 2, "leader 应恰好 2 次（拆解 + 汇总）");

  const time = (id) => { const c = calls.find((x) => x.startsWith(id)); const m = c.split("|")[1].split("-"); return { start: +m[0], end: +m[1] }; };
  assert.ok(overlap(time("researcher#1"), time("developer#1")) && overlap(time("developer#1"), time("writer#1")), "三分支应真并发（时间重叠）");

  const evTypes = events.map((e) => e.type);
  for (const et of ["run_started", "task_created", "handoff_requested", "run_completed"])
    assert.ok(evTypes.includes(et), `并行事件流应含 ${et}`);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].sequence > events[i - 1].sequence, "事件 sequence 应严格递增");
});
