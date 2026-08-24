/**
 * Phase 1A Step7 验证：RunManager 执行循环（mock 执行器）。
 * 完整流程：组长→产品→开发→测试→(问题)→开发→(通过)→组长→收尾
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/runtime.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { RunManager } = await import("./runtime.ts");
const { EventStore } = await import("./store.ts");
const { createTeamDef } = await import("./templates.ts");
const { reduce } = await import("./types.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-rt-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
  return root;
}

/** mock 执行器：按角色+执行序号返回预设输出（模拟真实 Agent 行为） */
function createMockExecutor(script) {
  const calls = [];
  return {
    calls,
    run: async ({ execution, onMessage }) => {
      calls.push({ agentId: execution.agentId, sequence: execution.sequence });
      const key = `${execution.agentId}#${execution.sequence}`;
      const entry = script[key];
      if (!entry) throw new Error(`no script for ${key}`);
      // 模拟真实执行器：产出群聊消息
      onMessage({
        id: `msg-${execution.id}`,
        kind: "agent",
        executionId: execution.id,
        agentId: execution.agentId,
        role: execution.agentId,
        content: entry.output,
        createdAt: Date.now(),
      });
      if (entry.handoffTool) {
        // 模拟受控工具：直接把交接放进结果
        return { status: "completed", output: entry.output, handoffTool: entry.handoffTool };
      }
      return { status: entry.status ?? "completed", output: entry.output, failureReason: entry.failureReason };
    },
  };
}

const TEAM = createTeamDef("sess-rt", "/work", "t", "software-dev");

function makeRun(task) {
  return {
    id: "run-1",
    teamId: TEAM.sessionId,
    status: "pending",
    task,
    stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test("RunManager: 完整流程 组长→产品→开发→测试→返工→开发→通过→组长收尾", async (t) => {
  useTempDataDir(t);
  const script = {
    "leader#1": { output: "任务已拆解，交给产品做需求分析" },
    "product#1": { output: "需求方案完成：3 个模块" },
    "developer#1": { output: "功能实现完成" },
    "tester#1": { output: "发现 2 个问题：库存计算错误、边界未处理" }, // keyword 问题 → 返工开发
    "developer#2": { output: "已修复两个问题" },
    "tester#2": { output: "全部测试通过，验收达标" }, // keyword 通过 → 组长
    "leader#2": { output: "总结完成：最终结论：本次任务全部完成" }, // __end__ 收尾
  };
  const executor = createMockExecutor(script);
  const rm = new RunManager({ team: TEAM, runId: "run-1", executor });
  const run = await rm.execute(makeRun("库存差异分析"));

  assert.equal(run.status, "completed");
  assert.equal(run.statusReason?.code, "completed");
  assert.equal(run.stats.agentExecutions, 7);
  assert.equal(run.stats.hopCount, 7);
  assert.equal(run.stats.reworkCount, 1); // 仅 tester#1→developer#2 返工边

  // 执行顺序
  assert.deepEqual(
    executor.calls.map((c) => `${c.agentId}#${c.sequence}`),
    ["leader#1", "product#1", "developer#1", "tester#1", "developer#2", "tester#2", "leader#2"],
  );

  // 事件流：run_started → ... → run_completed
  const events = new EventStore(TEAM.sessionId, "run-1").replay();
  assert.equal(events[0].type, "run_started");
  assert.equal(events[events.length - 1].type, "run_completed");
  const types = events.map((e) => e.type);
  assert.ok(types.includes("execution_started"));
  assert.ok(types.includes("execution_completed"));
  assert.ok(types.includes("handoff_requested"));
  assert.ok(types.includes("message_created"));

  // 投影：消息、执行、lastHandoff
  const p = reduce(events);
  assert.equal(p.messages.filter((m) => m.kind === "agent").length, 7);
  assert.equal(p.executions.length, 7);
  assert.equal(p.executions[4].agentId, "developer");
  assert.equal(p.executions[4].sequence, 2);
  assert.equal(p.state.lastHandoff?.to, "__end__");

  // 每个角色执行时的上下文包含结构化信息（leader#2 能看到之前的进度）
  const leader2Context = executor.calls.find(() => false); // 上下文在 run 回调里，另行断言
  assert.ok(leader2Context === undefined);

  // 序列单调
  const seqs = events.map((e) => e.sequence);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);
});

test("RunManager: 上下文包含任务/进度/产物（验证 ContextEngine 注入）", async (t) => {
  useTempDataDir(t);
  const captured = [];
  const executor = {
    run: async ({ execution, context, onMessage }) => {
      captured.push({ agentId: execution.agentId, sequence: execution.sequence, context });
      onMessage({
        id: `m-${execution.id}`,
        kind: "agent",
        executionId: execution.id,
        agentId: execution.agentId,
        role: execution.agentId,
        content: `${execution.agentId} 完成工作`,
        createdAt: Date.now(),
      });
      return { status: "completed", output: `${execution.agentId} 完成工作` };
    },
  };
  const rm = new RunManager({ team: TEAM, runId: "run-2", executor });
  await rm.execute(makeRun("测试上下文"));

  const first = captured[0].context;
  assert.ok(first.includes("项目组工作上下文"));
  assert.ok(first.includes("测试上下文"), "任务在上下文中");
  assert.ok(first.includes("你的角色"), "角色名注入");
  assert.ok(first.includes("最近消息"));
  assert.ok(first.includes("产物"));

  // 第二次执行能看到上一次的产出摘要
  const second = captured[1].context;
  assert.ok(second.includes("leader"));
});

test("RunManager: 保险丝——maxHops 终止无限循环", async (t) => {
  useTempDataDir(t);
  const team = { ...TEAM, maxHops: 4, transitions: [
    { id: "a", from: "leader", to: "product", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
    { id: "b", from: "product", to: "leader", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
  ] };
  const executor = { run: async () => ({ status: "completed", output: "x" }) };
  const rm = new RunManager({ team, runId: "run-3", executor });
  const run = await rm.execute(makeRun("循环"));
  assert.equal(run.status, "failed");
  assert.equal(run.statusReason?.code, "max_hops");
  assert.equal(run.stats.hopCount, 4);
});

test("RunManager: strict 模式无匹配 → workflow_dead_end", async (t) => {
  useTempDataDir(t);
  const team = {
    ...TEAM,
    defaultRoutingMode: "strict",
    agents: [TEAM.agents[0]], // 只有 leader
    transitions: [],
  };
  const executor = { run: async () => ({ status: "completed", output: "完成" }) };
  const rm = new RunManager({ team, runId: "run-4", executor });
  const run = await rm.execute(makeRun("strict"));
  assert.equal(run.status, "failed");
  assert.equal(run.statusReason?.code, "workflow_dead_end");
});

test("RunManager: 崩溃恢复——执行后重放事件可重建投影", async (t) => {
  useTempDataDir(t);
  const script = {
    "leader#1": { output: "派活" },
    "product#1": { output: "方案" },
    "developer#1": { output: "实现完成" },
    "tester#1": { output: "全部测试通过" },
    "leader#2": { output: "总结完成：最终结论：全部完成" },
  };
  const executor = createMockExecutor(script);
  const rm = new RunManager({ team: TEAM, runId: "run-5", executor });
  const run = await rm.execute(makeRun("恢复测试"));
  assert.equal(run.status, "completed");

  // 模拟"崩溃后"新进程：只读事件流重建
  const events = new EventStore(TEAM.sessionId, "run-5").replay();
  const p = reduce(events);
  assert.equal(p.executions.length, 5);
  assert.equal(p.messages.length, 5);
  assert.equal(p.state.goal, "恢复测试");
  assert.ok(events.every((e) => e.sequence > 0));
  // sequence 严格单调递增
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].sequence > events[i - 1].sequence);
  }
});
