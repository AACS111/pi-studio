/**
 * 验证本次修复：①execution_completed 带 stats 的投影；②agent_progress 事件模型；③readRunMeta token 聚合。
 * 运行：node --test lib/team/visibility.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { reduce, emptyProjections } = await import("./types.ts");
const { EventStore, TeamStore } = await import("./store.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-vis-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
  return root;
}

const STATS = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 200,
  cacheWriteTokens: 50,
  totalTokens: 1750,
  cost: 0.0123,
  userMessages: 2,
  assistantMessages: 5,
  toolCalls: 8,
  toolResults: 8,
  totalMessages: 15,
};

test("execution_completed 带 stats → 投影 execution.stats 正确落位", () => {
  const events = [
    { type: "run_started", sequence: 1, timestamp: 100, runId: "r1", task: "t", entryAgentId: "leader" },
    {
      type: "execution_started",
      sequence: 2,
      timestamp: 200,
      execution: {
        id: "r1-leader-1", runId: "r1", agentId: "leader", sequence: 1,
        status: "running", startedAt: 200, sessionId: "r1-leader-1",
      },
    },
    {
      type: "execution_completed",
      sequence: 3,
      timestamp: 900,
      executionId: "r1-leader-1",
      status: "completed",
      stats: STATS,
    },
  ];
  const p = reduce(events);
  assert.equal(p.executions.length, 1);
  const exec = p.executions[0];
  assert.equal(exec.status, "completed");
  assert.equal(exec.completedAt, 900);
  assert.deepEqual(exec.stats, STATS);
  assert.equal(exec.stats?.totalTokens, 1750);
  assert.equal(exec.stats?.toolCalls, 8);
});

test("agent_progress 事件不改变投影（事件流独立通道）", () => {
  const events = [
    { type: "run_started", sequence: 1, timestamp: 100, runId: "r1", task: "t", entryAgentId: "leader" },
    {
      type: "execution_started",
      sequence: 2,
      timestamp: 200,
      execution: {
        id: "r1-leader-1", runId: "r1", agentId: "leader", sequence: 1,
        status: "running", startedAt: 200, sessionId: "r1-leader-1",
      },
    },
    { type: "agent_progress", sequence: 3, timestamp: 300, executionId: "r1-leader-1", agentId: "leader", kind: "thinking", content: "正在分析…" },
    { type: "agent_progress", sequence: 4, timestamp: 400, executionId: "r1-leader-1", agentId: "leader", kind: "tool", content: "📖 读取 x.ts" },
  ];
  const p = reduce(events);
  assert.equal(p.messages.length, 0);
  assert.equal(p.state.artifacts.length, 0);
  assert.equal(p.executions.length, 1);
  // 事件本身可被事件流消费（agent_progress 是合法 TeamEvent）
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["run_started", "execution_started", "agent_progress", "agent_progress"]);
});

test("EventStore 落盘 → readRunMeta tokensUsed 聚合多个 execution stats", (t) => {
  useTempDataDir(t);
  const store = new EventStore("sess-1", "run-1");
  store.append({ type: "run_started", runId: "run-1", task: "task", entryAgentId: "leader" });
  store.append({
    type: "execution_started",
    execution: { id: "run-1-leader-1", runId: "run-1", agentId: "leader", sequence: 1, status: "running", startedAt: 1, sessionId: "s" },
  });
  store.append({ type: "execution_completed", executionId: "run-1-leader-1", status: "completed", stats: STATS });
  store.append({
    type: "execution_started",
    execution: { id: "run-1-product-1", runId: "run-1", agentId: "product", sequence: 1, status: "running", startedAt: 2, sessionId: "s" },
  });
  store.append({ type: "execution_completed", executionId: "run-1-product-1", status: "completed", stats: { ...STATS, totalTokens: 2500 } });
  store.append({ type: "run_completed", statusReason: { code: "completed", message: "done" } });

  const meta = TeamStore.readRunMeta("sess-1", "run-1");
  assert.ok(meta);
  assert.equal(meta.stats.tokensUsed, 1750 + 2500);
  assert.equal(meta.stats.agentExecutions, 2);
  assert.equal(meta.status, "completed");
});

test("execution_started 带 sessionPath → 投影保留（回放/审计入口）", () => {
  const events = [
    { type: "run_started", sequence: 1, timestamp: 100, runId: "r1", task: "t", entryAgentId: "leader" },
    {
      type: "execution_started",
      sequence: 2,
      timestamp: 200,
      execution: {
        id: "r1-leader-1", runId: "r1", agentId: "leader", sequence: 1,
        status: "running", startedAt: 200, sessionId: "r1-leader-1",
        sessionPath: "/data/teams/sess/runs/r1/sessions/r1-leader-1.jsonl",
      },
    },
  ];
  const p = reduce(events);
  assert.equal(p.executions[0].sessionPath, "/data/teams/sess/runs/r1/sessions/r1-leader-1.jsonl");
});
