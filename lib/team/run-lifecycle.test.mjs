/**
 * 项目组「从发送消息到结束」完整生命周期测试（mock 执行器，不依赖真实模型）。
 *
 * 与 exec-mode.test.mjs 的差异：那个文件侧重「执行模式 → 有效团队视图 / 复杂度 / 执行链」；
 * 本文件侧重「一个 run 从 run_started 到 run_completed 的全量事件流是否完整、单调、可重建」，
 * 并覆盖 exec-mode / fullflow 未触及的边界：startAgentId 指定非入口角色。
 *
 * 核心断言（每个 run）：
 *   - run 能到终态（completed），statusReason.code 合法
 *   - 事件流开头是 run_started、结尾含 run_completed
 *   - 每个 execution 都有 execution_started + execution_completed（不悬挂）
 *   - 每个 agent 执行都有 message_created（产出可见）
 *   - 根任务 TASK-001 由 runtime 创建（task_created）
 *   - 事件 sequence 严格单调递增、不重不漏
 *   - 落盘后 reduce 能重建投影（executions / messages / tasks 一致）
 *
 * 运行：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/team/run-lifecycle.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { startTeamRun, readRunDetail } = await import("./registry.ts");
const { createTeamDef } = await import("./templates.ts");
const { classifyTask } = await import("./task-classify.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-runlf-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带脚本应答的 mock 执行器：记录每次执行的 mode/seq；支持 delay 证明并发 */
function makeExecutor(script, log) {
  return {
    run: async ({ execution, mode, onMessage }) => {
      const key = `${execution.agentId}#${execution.sequence}`;
      const e = script[key] ?? { output: `${execution.agentId}#${execution.sequence}` };
      if (e.delayMs) await sleep(e.delayMs);
      log.push({ key, mode, seq: execution.sequence });
      onMessage({
        id: `m-${execution.id}`,
        kind: "agent",
        executionId: execution.id,
        agentId: execution.agentId,
        role: execution.agentId,
        content: e.output,
        createdAt: Date.now(),
      });
      return { status: e.st ?? "completed", output: e.output, failureReason: e.fr, ...(e.verdict ? { verdict: e.verdict } : {}) };
    },
  };
}

async function waitDone(sessionId, runId, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { run } = readRunDetail(sessionId, runId);
    if (run.status !== "running" && run.status !== "pending") return run;
    await sleep(30);
  }
  throw new Error(`run 未在限时内结束: ${runId}`);
}

/** 统一验证一个 run 的完整生命周期与事件流 */
function assertCompleteLifecycle(sessionId, runId, expectedFinal) {
  const { run, events, projections } = readRunDetail(sessionId, runId);
  // 1) 终态
  assert.equal(run.status, expectedFinal, `run 终态应为 ${expectedFinal}`);
  assert.ok(run.statusReason?.code, "run 应有 statusReason.code");
  // 2) 事件开头/结尾
  assert.equal(events[0].type, "run_started", "事件流应从 run_started 开始");
  assert.ok(events.some((e) => e.type === "run_completed" || e.type === "run_failed" || e.type === "run_cancelled"), "事件流应含终态事件");
  // 3) 根任务
  assert.ok(events.some((e) => e.type === "task_created" && e.task?.id === "TASK-001"), "应创建根任务 TASK-001");
  // 4) 每个 execution 都闭合 + 有 message
  const started = events.filter((e) => e.type === "execution_started");
  const completedIds = new Set(events.filter((e) => e.type === "execution_completed").map((e) => e.executionId));
  for (const s of started) {
    assert.ok(completedIds.has(s.execution.id), `execution ${s.execution.id} 应有 execution_completed（未悬挂）`);
    assert.ok(
      events.some((e) => e.type === "message_created" && e.message?.executionId === s.execution.id),
      `execution ${s.execution.id} 应产出 agent 消息`,
    );
  }
  // 5) sequence 严格单调
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].sequence > events[i - 1].sequence, `事件 sequence 应严格递增，第 ${i} 条: ${events[i].sequence} <= ${events[i - 1].sequence}`);
  }
  const seqs = events.map((e) => e.sequence);
  assert.equal(new Set(seqs).size, seqs.length, "事件 sequence 不重不漏");
  // 6) 投影可重建且与事件一致
  assert.equal(projections.executions.length, started.length, "投影 execution 数 = execution_started 数");
  assert.equal(projections.messages.filter((m) => m.kind === "agent").length, started.length, "投影 agent 消息数 = execution 数");
  return { run, events, projections };
}

// ==================== auto(简单任务) → solo 完整生命周期 ====================
test("生命周期: auto 简单任务 → solo 完整事件流（solo 模式/单入口）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-auto", "/w", "t");
  const log = [];
  const task = "给页面加一个动态背景";
  const { runId } = startTeamRun(team, task, undefined, undefined, makeExecutor(
    { "leader#1": { output: "已完成动态背景：支持开关/多样式" } }, log,
  ));
  const run = await waitDone(team.sessionId, runId);
  const { events } = assertCompleteLifecycle(team.sessionId, runId, "completed");
  assert.equal(run.complexity, "simple", "简单任务 complexity=simple");
  assert.equal(log.length, 1, "solo 只跑入口 1 次");
  assert.equal(log[0].mode, "solo", "入口以 solo 模式运行");
  assert.ok(events.some((e) => e.type === "run_completed" && e.statusReason?.code === "completed"));
});

// ==================== solo 模式（即使任务看起来 complex）====================
test("生命周期: solo 强制 simple + 单独完成", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-solo", "/w", "t");
  const log = [];
  const complexTask = "搭建一个多模块内容管理平台";
  const { runId } = startTeamRun(team, complexTask, "solo", undefined, makeExecutor(
    { "leader#1": { output: "单会话完成整体任务" } }, log,
  ));
  const run = await waitDone(team.sessionId, runId);
  assertCompleteLifecycle(team.sessionId, runId, "completed");
  assert.equal(run.complexity, "simple", "solo 强制 simple");
  assert.equal(log.length, 1, "solo 只跑入口 1 次");
});

// ==================== serial 完整生命周期 ====================
test("生命周期: serial 串行链全事件流（含手off/消息/根任务）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-serial", "/w", "t", "software-dev");
  const log = [];
  const script = {
    "leader#1": { output: "拆解：需求→设计→实现→验证" },
    "product#1": { output: "需求文档完成" },
    "developer#1": { output: "实现完成" },
    "tester#1": { output: "全部通过", verdict: "pass" },
    "leader#2": { output: "总结完成：最终结论：串行全绿" },
  };
  const { runId } = startTeamRun(team, "任意任务", "serial", undefined, makeExecutor(script, log));
  const run = await waitDone(team.sessionId, runId);
  const { events } = assertCompleteLifecycle(team.sessionId, runId, "completed");
  assert.equal(run.complexity, "complex", "serial 强制 complex");
  assert.deepEqual(log.map((l) => l.key), ["leader#1", "product#1", "developer#1", "tester#1", "leader#2"], "串行链");
  assert.ok(log.every((l) => l.mode === "orchestrated"), "串行角色 orchestrated 运行");
  // 串行链每一步都应有 handoff_requested（除首尾收尾）
  const handoffs = events.filter((e) => e.type === "handoff_requested");
  assert.ok(handoffs.length >= 3, `串行链应有多条 handoff，实际 ${handoffs.length}`);
});

// ==================== parallel 完整生命周期（真并发）====================
test("生命周期: parallel 网关分叉真并发 → merge → 测试 → 汇总", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-para", "/w", "t", "solver");
  const log = [];
  const stamps = {};
  const executor = {
    run: async ({ execution, mode, onMessage }) => {
      const key = `${execution.agentId}#${execution.sequence}`;
      const e = {
        "leader#1": { output: "拆解", delayMs: 0 },
        "researcher#1": { output: "调研结论", delayMs: 30 },
        "developer#1": { output: "实现完成", delayMs: 30 },
        "writer#1": { output: "文档完成", delayMs: 30 },
        "tester#1": { output: "交叉验证通过", verdict: "pass", delayMs: 0 },
        "leader#2": { output: "总结完成：最终结论：并行全绿", delayMs: 0 },
      }[key];
      if (!e) throw new Error("no script " + key);
      const start = Date.now();
      if (e.delayMs) await sleep(e.delayMs);
      stamps[key] = [start, Date.now()];
      log.push({ key, mode, seq: execution.sequence });
      onMessage({ id: `m-${execution.id}`, kind: "agent", executionId: execution.id, agentId: execution.agentId, role: execution.agentId, content: e.output, createdAt: Date.now() });
      return { status: "completed", output: e.output, ...(e.verdict ? { verdict: e.verdict } : {}) };
    },
  };
  const { runId } = startTeamRun(team, "多模块平台", "parallel", undefined, executor);
  await waitDone(team.sessionId, runId);
  assertCompleteLifecycle(team.sessionId, runId, "completed");
  assert.deepEqual(log.map((l) => l.key), ["leader#1", "researcher#1", "developer#1", "writer#1", "tester#1", "leader#2"], "并行链");
  const overlap = (a, b) => Math.max(a[0], b[0]) < Math.min(a[1], b[1]);
  assert.ok(overlap(stamps["researcher#1"], stamps["developer#1"]), "分叉分支真并发");
});

// ==================== custom 自绘流程 ====================
test("生命周期: custom 使用自绘边（不引入内置角色）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-custom", "/w", "t");
  team.transitions = [
    { id: "c0", from: "leader", to: "developer", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, onlyExecutionSeq: 1 },
    { id: "c1", from: "developer", to: "leader", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
    { id: "c2", from: "leader", to: "__end__", priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["总结完成", "最终结论"] } } },
  ];
  const log = [];
  const script = {
    "leader#1": { output: "拆解" },
    "developer#1": { output: "开发完成" },
    "leader#2": { output: "总结完成：最终结论：自定义跑通" },
  };
  const { runId } = startTeamRun(team, "自定义任务", "custom", undefined, makeExecutor(script, log));
  await waitDone(team.sessionId, runId);
  assertCompleteLifecycle(team.sessionId, runId, "completed");
  assert.deepEqual(log.map((l) => l.key), ["leader#1", "developer#1", "leader#2"], "custom 走自绘边");
  assert.ok(!log.some((l) => l.key.startsWith("product")), "custom 不引入 product");
});

// ==================== startAgentId 指定非入口 ====================
test("生命周期: serial + startAgentId 指定非入口角色（跳过入口直接开始）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-starts", "/w", "t", "software-dev");
  const log = [];
  const script = {
    "developer#1": { output: "开发直接开始" },
    "tester#1": { output: "通过", verdict: "pass" },
    "leader#1": { output: "总结完成：最终结论：done" },
  };
  const { runId } = startTeamRun(team, "任务", "serial", "developer", makeExecutor(script, log));
  await waitDone(team.sessionId, runId);
  assertCompleteLifecycle(team.sessionId, runId, "completed");
  assert.deepEqual(log.map((l) => l.key), ["developer#1", "tester#1", "leader#1"], "从指定角色开始");
  // 根任务 assignedAgentId 应为指定起始角色（developer）
  const { projections } = readRunDetail(team.sessionId, runId);
  assert.equal(projections.tasks[0].assignedAgentId, "developer", "根任务指派给起始角色");
});

// ==================== 事件落盘可重放重建 ====================
test("生命周期: run 结束后事件落盘 + reduce 重放可重建投影（不依赖内存）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-replay", "/w", "t", "software-dev");
  const script = {
    "leader#1": { output: "拆解" },
    "product#1": { output: "方案" },
    "developer#1": { output: "实现" },
    "tester#1": { output: "通过", verdict: "pass" },
    "leader#2": { output: "总结完成：最终结论：done" },
  };
  const { runId } = startTeamRun(team, "任务", "serial", undefined, makeExecutor(script, []));
  await waitDone(team.sessionId, runId);
  assertCompleteLifecycle(team.sessionId, runId, "completed");

  // 模拟重启：只从落盘 events 重建，不依赖 registry 内存
  const { EventStore } = await import("./store.ts");
  const { reduce } = await import("./types.ts");
  const { run: meta } = readRunDetail(team.sessionId, runId); // registry 内存 run
  const store = new EventStore(team.sessionId, runId);
  const events = store.replay();
  const p = reduce(events);
  assert.equal(p.executions.length, meta.stats.agentExecutions, "重放投影 execution 数 = 统计数");
  assert.equal(p.messages.filter((m) => m.kind === "agent").length, meta.stats.agentExecutions, "重放投影 agent 消息数 = 统计数");
});

// ==================== 空任务/极短任务边界 ====================
test("生命周期: 空任务兜底不崩（classify 走 complex）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-empty", "/w", "t");
  // 空的 startTeamRun 不校验 task（API 层才校验），这里直接给空串，确认引擎层不崩
  const log = [];
  const { runId } = startTeamRun(team, "  ", undefined, undefined, makeExecutor({ "leader#1": { output: "总结完成：最终结论：done" } }, log));
  const run = await waitDone(team.sessionId, runId);
  assert.ok(["completed", "failed"].includes(run.status), `空任务应到终态，实际 ${run.status}`);
  assert.equal(classifyTask(""), "complex", "空串 classify=complex（兜底走编排）");
});

// ==================== 执行记录 sessionId/sessionPath 收敛为每角色一份 ====================
test("生命周期: 执行记录 sessionId/sessionPath 收敛为每角色一份（同角色跨执行共享 .jsonl）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-perrole", "/w", "t", "software-dev");
  const script = {
    "leader#1": { output: "拆解" },
    "product#1": { output: "方案" },
    "developer#1": { output: "实现" },
    "tester#1": { output: "通过", verdict: "pass" },
    "leader#2": { output: "总结完成：最终结论：done" },
  };
  const { runId } = startTeamRun(team, "任务", "serial", undefined, makeExecutor(script, []));
  await waitDone(team.sessionId, runId);
  const { projections } = readRunDetail(team.sessionId, runId);

  // leader 出现两次（#1 排活 / #2 总结），但 sessionId / sessionPath 都应收敛为同一份（每角色一个 .jsonl）
  const leaderExecs = projections.executions.filter((e) => e.agentId === "leader");
  assert.equal(leaderExecs.length, 2, "leader 应执行两次");
  for (const e of leaderExecs) {
    assert.equal(e.sessionId, `${runId}-leader`, "leader 的 sessionId 应为每角色一份（不带 -seq）");
    assert.ok(e.sessionPath.endsWith(`${runId}-leader.jsonl`), `leader sessionPath 应指向每角色一份 .jsonl，实际 ${e.sessionPath}`);
  }
  // 不同角色各自独立文件
  const devExec = projections.executions.find((e) => e.agentId === "developer");
  assert.equal(devExec.sessionId, `${runId}-developer`, "developer 的 sessionId 独立");
  // execution.id 仍保持每次执行唯一（事件路由/审计用）
  const ids = projections.executions.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "execution.id 仍每次执行唯一");
});

// ==================== 实际生效模型透传（供 UI 显示「每个角色用了什么模型」） ====================
test("生命周期: executor 返回 model → execution_completed 事件与投影均带具体模型名", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-model", "/w", "t");
  const executor = {
    run: async ({ execution, onMessage }) => {
      onMessage({ id: `m-${execution.id}`, kind: "agent", executionId: execution.id, agentId: execution.agentId, role: execution.agentId, content: "完成", createdAt: Date.now() });
      // 模拟真实会话解析出的实际模型（agent.model 为空=跟随系统时也应有具体模型名）
      return { status: "completed", output: "完成", model: { provider: "deepseek", modelId: "deepseek-chat" } };
    },
  };
  const { runId } = startTeamRun(team, "加一个动态背景", undefined, undefined, executor);
  const run = await waitDone(team.sessionId, runId);
  assert.equal(run.status, "completed");
  const { events, projections } = readRunDetail(team.sessionId, runId);
  // execution_completed 事件带模型名
  const completed = events.find((e) => e.type === "execution_completed");
  assert.ok(completed, "应有 execution_completed 事件");
  assert.equal(completed?.model?.provider, "deepseek");
  assert.equal(completed?.model?.modelId, "deepseek-chat");
  // 投影 execution.model 落位
  assert.equal(projections.executions[0]?.model?.modelId, "deepseek-chat", "投影 execution 应带实际模型名");
});

// ==================== no-progress 循环守卫（leader 反复交接已成功完成的下游 → 收敛完成而非 max_rework） ====================
test("生命周期: leader 反复交接已成功完成角色 → 循环守卫收敛完成（不触发 max_rework）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-loop", "/w", "t");
  team.executionMode = "custom";
  team.transitions = [];   // 无 transitions → 完全由 leader 的 team_handoff 驱动路由
  // leader ⇄ be-developer ping-pong：leader 每次都用 handoff 派活给 be-developer，be-developer 完成又回 leader
  const executor = {
    run: async ({ execution }) => {
      const agent = execution.agentId, seq = execution.sequence;
      if (agent === "leader" && seq === 1) return { status: "completed", output: "分配", handoffTool: { to: "be-developer" } };
      if (agent === "be-developer" && seq === 1) return { status: "completed", output: "实现完成", handoffTool: { to: "leader" } };
      // 第二次 leader 仍把同一角色派活 → 触发循环守卫
      if (agent === "leader" && seq === 2) return { status: "completed", output: "已交接给 be-developer", handoffTool: { to: "be-developer" } };
      return { status: "completed", output: "其余" };
    },
  };
  const { runId } = startTeamRun(team, "多模块改造任务", "custom", undefined, executor);
  const run = await waitDone(team.sessionId, runId);
  // 关键：run 以 completed 收敛（而非 max_rework 硬失败）
  assert.equal(run.status, "completed", `应收敛为 completed，实际 ${run.status} ${JSON.stringify(run.statusReason)}`);
  assert.ok(run.statusReason?.code !== "max_rework", "不应触发 max_rework");
  const { events, projections } = readRunDetail(team.sessionId, runId);
  // leader 只跑 2 次（分配 + 触发守卫的那次），be-developer 只跑 1 次（第 2 次被守卫拦下）
  const leaderRuns = projections.executions.filter((e) => e.agentId === "leader").length;
  const devRuns = projections.executions.filter((e) => e.agentId === "be-developer").length;
  assert.equal(leaderRuns, 2, `leader 应只跑 2 次，实际 ${leaderRuns}（不再无限重派）`);
  assert.equal(devRuns, 1, `be-developer 第 2 次被循环守卫拦下，应只跑 1 次，实际 ${devRuns}`);
  // 收敛提示系统消息已发出
  assert.ok(events.some((e) => e.type === "message_created" && e.message?.kind === "system" && /无进展|空转|收敛/.test(e.message.content)), "应有循环收敛提示消息");
});

// ==================== 变更文件透传（executor 返回 changedFiles → 事件 + 投影） ====================
test("生命周期: execution_completed 携带 changedFiles → 事件与投影 execution 均保留（供 UI 展示变更文件）", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sesslf-files", "/w", "t");
  const executor = {
    run: async ({ execution, onMessage }) => {
      onMessage({ id: `m-${execution.id}`, kind: "agent", executionId: execution.id, agentId: execution.agentId, role: execution.agentId, content: "已改动", createdAt: Date.now() });
      // 模拟角色 edit/write 了项目内文件（普通会话「变更文件」卡片的数据源）
      return {
        status: "completed",
        output: "已改动",
        changedFiles: [
          { filePath: "/w/src/MPSHandler.java", kind: "edit" },
          { filePath: "/w/src/TcMslFileServiceImpl.java", kind: "write" },
        ],
      };
    },
  };
  const { runId } = startTeamRun(team, "任务", "custom", undefined, executor);
  const run = await waitDone(team.sessionId, runId);
  assert.equal(run.status, "completed");
  const { events, projections } = readRunDetail(team.sessionId, runId);
  const completed = events.find((e) => e.type === "execution_completed");
  assert.ok(completed?.changedFiles, "execution_completed 事件应携带 changedFiles");
  assert.equal(completed?.changedFiles?.[0]?.filePath, "/w/src/MPSHandler.java");
  assert.ok(projections.executions[0]?.changedFiles?.length === 2, "投影 execution 应保留 changedFiles");
});
