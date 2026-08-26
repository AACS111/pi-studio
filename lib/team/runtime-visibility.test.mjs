/**
 * 验证本次修复端到端链路：mock 执行器带 stats + agent_progress 实时进度，
 * 经 RunManager → EventStore 落盘 → 投影/详情读取 全链路正确。
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/runtime-visibility.test.mjs
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-rv-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
  return root;
}

const STATS = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150, cost: 0.001, userMessages: 1, assistantMessages: 3, toolCalls: 4, toolResults: 4, totalMessages: 8 };

test("executor 带 stats + agent_progress → 全链路落盘且投影正确", async (t) => {
  useTempDataDir(t);
  const TEAM = createTeamDef("sess-rv", "/work", "t", "software-dev");
  const events = [];
  const executor = {
    run: async ({ execution, onMessage, onEvent }) => {
      // 模拟真实执行器：执行中转发实时进度（thinking + 工具）
      onEvent({ type: "agent_progress", executionId: execution.id, agentId: execution.agentId, kind: "thinking", content: "正在分析需求…" });
      onEvent({ type: "agent_progress", executionId: execution.id, agentId: execution.agentId, kind: "tool", content: "📖 读取 lib/team/types.ts" });
      onMessage({
        id: `msg-${execution.id}`,
        kind: "agent",
        executionId: execution.id,
        agentId: execution.agentId,
        role: execution.agentId,
        content: `output-${execution.agentId}`,
        createdAt: Date.now(),
      });
      return { status: "completed", output: `output-${execution.agentId}`, stats: STATS };
    },
  };

  const manager = new RunManager({
    team: TEAM,
    runId: "run-1",
    executor,
    onEvent: (e) => events.push(e),
  });
  const run = {
    id: "run-1",
    teamId: TEAM.sessionId,
    status: "pending",
    task: "测试任务",
    stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const finalRun = await manager.execute(run);

  // 1) run 汇总 tokensUsed 累加（模板团队多角色都会执行，断言 ≥ 单次 stats）
  assert.ok(finalRun.stats.tokensUsed >= 150);
  assert.ok(finalRun.stats.agentExecutions >= 1);

  // 2) 事件流包含 agent_progress（实时进度可被 SSE 消费）
  const progressEvents = events.filter((e) => e.type === "agent_progress");
  assert.ok(progressEvents.length >= 2);
  assert.equal(progressEvents[0].kind, "thinking");
  assert.ok(progressEvents.some((e) => e.kind === "tool"));
  assert.equal(progressEvents[0].content, "正在分析需求…");

  // 3) execution_completed 带 stats（取最后一个）
  const completed = [...events].reverse().find((e) => e.type === "execution_completed");
  assert.ok(completed);
  assert.equal(completed.stats.totalTokens, 150);
  assert.equal(completed.stats.toolCalls, 4);

  // 4) 落盘后可回放：投影里 execution.stats 正确
  const store = new EventStore(TEAM.sessionId, "run-1");
  const replayed = store.replay();
  assert.ok(replayed.some((e) => e.type === "agent_progress"));
  const p = reduce(replayed);
  assert.ok(p.executions.length >= 1);
  assert.equal(p.executions[0].stats?.totalTokens, 150);
  // agent_progress 不污染消息流
  assert.equal(p.messages.length, p.executions.length);
});

test("execution_started 携带 sessionPath（回放/审计入口）", async (t) => {
  useTempDataDir(t);
  const TEAM = createTeamDef("sess-rv2", "/work", "t", "software-dev");
  const executor = {
    run: async ({ execution }) => ({ status: "completed", output: "ok", stats: STATS }),
  };
  const manager = new RunManager({ team: TEAM, runId: "run-1", executor });
  const run = {
    id: "run-1", teamId: TEAM.sessionId, status: "pending", task: "t",
    stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 },
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  await manager.execute(run);
  const store = new EventStore(TEAM.sessionId, "run-1");
  const started = store.replay().find((e) => e.type === "execution_started");
  assert.ok(started);
  const sp = started.execution.sessionPath;
  assert.ok(typeof sp === "string" && sp.length > 0);
  assert.ok(sp.includes("sessions"));
});
