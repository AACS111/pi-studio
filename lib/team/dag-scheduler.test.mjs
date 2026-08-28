/**
 * DAG 编排泵（plan-then-dispatch）回归测试：
 *   ① 计划提交 → 任务创建/TASK-001 收口/计划路线图消息
 *   ② dependsOn 就绪集派发：上游先跑，无依赖并行
 *   ③ verdict=fail → 同任务重试并附失败反馈（不扩散到无关角色）
 *   ④ 重试耗尽 → 级联跳过下游依赖任务 + best-effort 完成报告
 *   ⑤ planner 连续失败 → 自动回退 transitions 引擎跑完 run
 *   ⑥ 终止性 & TASK-001 结束后任务投影一致
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/dag-scheduler.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { startTeamRun, readRunDetail } = await import("./registry.ts");
const { createTeamDef } = await import("./templates.ts");
const { validatePlanSubmission } = await import("./tools.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-dag-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDone(sessionId, runId, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { run } = readRunDetail(sessionId, runId);
    if (run.status !== "running" && run.status !== "pending") return run;
    await sleep(30);
  }
  throw new Error(`run 未在限时内结束: ${runId}`);
}

/** DAG mock 执行器：
 *  - script["leader#1"].plan / .planError → planner 行为
 *  - script["developer#1"] 等其余按 agentId#seq 应答；支持 verdict/failureReason/changedFiles/delayMs
 *  - contexts 记录每次收到的 context，验证上游交付物注入 */
function makeDagExecutor(script, log) {
  return {
    contexts: [],
    async run({ execution, context, onMessage }) {
      const key = `${execution.agentId}#${execution.sequence}`;
      const e = script[key] ?? { output: `${execution.agentId}#${execution.sequence}` };
      if (e.delayMs) await sleep(e.delayMs);
      this.contexts.push({ key, context });
      log.push({ key, startedAt: Date.now() });
      onMessage({
        id: `m-${execution.id}`, kind: "agent", executionId: execution.id,
        agentId: execution.agentId, role: execution.agentId,
        content: e.output ?? `${execution.agentId}#${execution.sequence} 完成`, createdAt: Date.now(),
      });
      return {
        status: e.st ?? "completed",
        output: e.output ?? `${execution.agentId}#${execution.sequence} 完成`,
        ...(e.verdict ? { verdict: e.verdict } : {}),
        ...(e.failureReason ? { failureReason: e.failureReason } : {}),
        ...(e.changedFiles ? { changedFiles: e.changedFiles } : {}),
        ...(e.plan ? { plan: e.plan } : {}),
        ...(e.planError ? { planError: e.planError } : {}),
      };
    },
  };
}

const PLAN_3 = [
  { id: "T1", title: "实现多选组件", agentId: "developer", dependsOn: [] },
  { id: "T2", title: "写使用文档", agentId: "writer", dependsOn: ["T1"] },
  { id: "T3", title: "跑通冒烟验证", agentId: "tester", dependsOn: [] }, // 与 T1 并行、不阻塞 T2? 不——T2 只依赖 T1
];

test("dag-scheduler ①②: 计划→建单→就绪集派发→finisher 收尾，任务投影与事件流一致", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("dag-1", "/w", "t"); team.orchestration = "dag";
  const log = [];
  const ex = makeDagExecutor({ "leader#1": { output: "计划如下…", plan: PLAN_3 } }, log);
  const { runId } = startTeamRun(team, "改造筛选器", "custom", undefined, ex);
  const run = await waitDone(team.sessionId, runId);

  assert.equal(run.status, "completed");
  const { events, projections } = readRunDetail(team.sessionId, runId);

  // executions：1 planner + 3 task(含并行) + 1 finisher = 5
  assert.equal(log.length, 5, `executions 应为 5（实际 ${log.length}）：${log.map((l) => l.key).join(",")}`);
  assert.equal(log[0].key, "leader#1", "第一轮是 planner");
  assert.equal(log[4].key, "leader#2", "最后是 finisher");

  // 就绪顺序：T1 与 T3 无依赖先行，T2 等 T1 完成后才被派发
  const order = log.map((l) => l.key);
  assert.ok(order.indexOf("developer#1") < order.indexOf("writer#1"), "T2(developer 后续) 必须晚于 T1？注意 writer#1 是 T2");

  // TASK-001 被拆解收口 + 3 个子任务全部 completed
  const tasksById = new Map(projections.tasks.map((x) => [x.id, x]));
  assert.equal(tasksById.get("TASK-001").status, "completed");
  const subtasks = projections.tasks.filter((x) => x.parentTaskId === "TASK-001");
  assert.equal(subtasks.length, 3);
  assert.ok(subtasks.every((x) => x.status === "completed"), JSON.stringify([...subtasks.map((s) => s.status)]));
  assert.ok(subtasks[0].planTaskId?.startsWith("T"), "planTaskId 已写入");

  // 计划路线图系统消息可见
  assert.ok(events.some((e) => e.type === "message_created" && e.message.content.includes("📋 执行计划已生成")), "应有计划路线图消息");

  // 上游交付物注入下游上下文（MetaGPT 式交接）
  const writerCtx = ex.contexts.find((c) => c.key === "writer#1")?.context ?? "";
  assert.match(writerCtx, /## 你的任务（TASK-\d+）/);
  assert.match(writerCtx, /【实现多选组件】/, "T2 的上下文应含 T1 交付物标题");
  assert.doesNotMatch(writerCtx, /sessions\/.*\.jsonl/, "任务上下文不应再指向 session jsonl");
});

test("dag-scheduler ③: verdict=fail 重试同任务且附失败反馈；通过后继续", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("dag-2", "/w", "t"); team.orchestration = "dag";
  const log = [];
  const script = {
    "leader#1": { output: "计划", plan: [
      { id: "T1", title: "改代码", agentId: "developer", dependsOn: [] },
      { id: "T2", title: "验证", agentId: "tester", dependsOn: ["T1"] },
    ] },
  };
  const executor = {
    contexts: [],
    async run(req) {
      const key = `${req.execution.agentId}#${req.execution.sequence}`;
      const e = script[key] ?? {};
      req.onMessage({
        id: `m-${req.execution.id}`, kind: "agent", executionId: req.execution.id,
        agentId: req.execution.agentId, role: req.execution.agentId,
        content: e.output ?? `${key} ok`, createdAt: Date.now(),
      });
      this.contexts.push({ key, context: req.context });
      log.push(key);
      if (key === "tester#1") return { status: "completed", output: "发现阻断问题：参数校验缺失", verdict: "fail" };
      return { status: "completed", output: e.output ?? `${key} ok`, ...(e.plan ? { plan: e.plan } : {}) };
    },
  };

  const { runId } = startTeamRun(team, "改造", "custom", undefined, executor);
  const run = await waitDone(team.sessionId, runId);
  assert.equal(run.status, "completed");

  const order = log.join(",");
  assert.match(order, /tester#1/, "T2 第一次执行存在");
  assert.match(order, /tester#2/, "T2 重试执行存在");
  const retryCtx = executor.contexts.find((c) => c.key === "tester#2")?.context ?? "";
  assert.match(retryCtx, /返工|失败/, "重试轮上下文应附失败反馈");
  assert.match(retryCtx, /参数校验缺失/, "反馈应包含上次失败原因/输出");

  // 消息层可见重试行
  const { events } = readRunDetail(team.sessionId, runId);
  assert.ok(events.some((e) => e.type === "message_created" && String(e.message.content).includes("🔁")), "应有 🔁 重试系统消息");
});

test("dag-scheduler ④: 重试耗尽 → 下游级联跳过 → best-effort 完成并在报告标注 ❌", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("dag-3", "/w", "t"); team.orchestration = "dag";
  team.maxReworkRounds = 1; // 首次 + 1 次重试即耗尽
  const log = [];
  const executor = {
    contexts: [],
    async run(req) {
      const key = `${req.execution.agentId}#${req.execution.sequence}`;
      const e = SCRIPT[key];
      req.onMessage({
        id: `m-${req.execution.id}`, kind: "agent", executionId: req.execution.id,
        agentId: req.execution.agentId, role: req.execution.agentId,
        content: e?.output ?? `${key} ok`, createdAt: Date.now(),
      });
      this.contexts.push({ key, context: req.context });
      log.push(key);
      if (key.startsWith("be-developer")) return { status: "failed", output: "", failureReason: "依赖服务不可用" };
      return { status: "completed", output: e?.output ?? `${key} ok`, ...(e?.plan ? { plan: e.plan } : {}) };
    },
  };
  const SCRIPT = {
    "leader#1": { output: "计划", plan: [
      { id: "T1", title: "外部集成", agentId: "be-developer", dependsOn: [] },
      { id: "T2", title: "依赖集成的验收", agentId: "tester", dependsOn: ["T1"] },
    ] },
  };
  const { runId } = startTeamRun(team, "接入外部服务", "custom", undefined, executor);
  const run = await waitDone(team.sessionId, runId);

  // 不硬失败：best-effort completed（区别于旧引擎 max_rework）
  assert.equal(run.status, "completed");
  // be-developer 被执行 1+maxRework 次
  const devRuns = log.filter((k) => k.startsWith("be-developer#"));
  assert.equal(devRuns.length, 2, `首次+1 次重试=${2}（实际 ${devRuns.length}:${devRuns.join(",")}）`);
  // 测试任务被级联跳过 → 没有任何 tester 执行
  assert.ok(!log.some((k) => k.startsWith("tester#")), "下游依赖任务应级联跳过");
  const { projections, events } = readRunDetail(team.sessionId, runId);
  const failed = projections.tasks.filter((x) => x.status === "failed");
  assert.equal(failed.length, 2, "终败任务与其下游都为 failed");
  assert.ok(events.some((e) => e.type === "message_created" && String(e.message.content).includes("❌")), "应有 ❌ 失败通告");
});

test("dag-scheduler ⑤: planner 两连败自动回退 transitions 引擎跑完 run", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("dag-4", "/w", "t");
  team.orchestration = "dag";
  const log = [];
  const executor = makeDagExecutor({
    "leader#1": { output: "我不会用工具" },                     // 无 plan
    "leader#2": { output: "再试也不行", planError: "未调用工具" }, // 无 plan
    // leader#3 已是回退路径的入口执行：正常输出 + handoff __end__ 由模拟返回层忽略
    "leader#3": { output: "直接完成（回退路径）" },
    "product#1": { output: "产品结论" },
    "developer#1": { output: "开发完成" },
    "tester#1": { output: "测试通过" },
  }, log);
  const { runId } = startTeamRun(team, "多模块平台", "custom", undefined, executor);
  const run = await waitDone(team.sessionId, runId);

  assert.equal(run.status, "completed");
  const { events } = readRunDetail(team.sessionId, runId);
  assert.ok(events.some((e) => e.type === "message_created" && String(e.message.content).includes("回退到传统工作流引擎")), "应发布回退说明");
  assert.ok(events.some((e) => e.type === "handoff_requested" || e.type === "execution_completed"), "回退后有真实执行流");
  // 回退路径至少跑了 product/developer/tester 中的一部分（transitions 图驱动）
  assert.ok(log.length >= 4, `回退后仍有多角色执行（${log.join(",")}）`);
});

// ==================== validatePlanSubmission 纯函数 ====================
function miniAgents(ids) { return { agents: ids.map((id) => ({ id })) }; }

test("validatePlanSubmission: 角色不存在/自依赖/循环依赖/超上限逐项拒绝", () => {
  const team = miniAgents(["a", "b"]);
  const bad = validatePlanSubmission(team, [{ title: "x", agentId: "ghost" }]);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /agentId.*ghost|ghost/);
  const self = validatePlanSubmission(team, [{ title: "x", agentId: "a", dependsOn: ["T1"] }]);
  assert.equal(self.ok, false);
  const cycle = validatePlanSubmission(team, [
    { title: "x", agentId: "a", dependsOn: ["T2"] },
    { title: "y", agentId: "b", dependsOn: ["T1"] },
  ]);
  assert.equal(cycle.ok, false);
  assert.match(cycle.error, /循环依赖/);
  const tooMany = validatePlanSubmission(team, Array.from({ length: 13 }, (_, i) => ({ title: `t${i}`, agentId: "a" })));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /上限/);
  const ok = validatePlanSubmission(team, [
    { title: "x", agentId: "a" },
    { title: "y", agentId: "b", dependsOn: ["T1"] },
  ]);
  assert.deepEqual(ok.tasks.map((p) => p.id), ["T1", "T2"]);
});
