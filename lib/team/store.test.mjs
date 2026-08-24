/**
 * Phase 1A Step1/2 验证：事件模型 reduce + EventStore + TeamStore + 模板。
 * 运行：node --test lib/team/store.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { reduce, emptyProjections } = await import("./types.ts");
const { EventStore, TeamStore, getTeamDir } = await import("./store.ts");
const { createTeamDef, TEAM_TEMPLATES } = await import("./templates.ts");

/** 每个测试用独立临时数据目录（PI_WEB_UPLOADS_DIR 隔离） */
function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
  return root;
}

function makeExecution(id, agentId, sequence, overrides = {}) {
  return {
    id,
    runId: "run-1",
    agentId,
    sequence,
    status: "running",
    startedAt: Date.now(),
    sessionId: `sess-${id}`,
    ...overrides,
  };
}

// ==================== reduce 投影 ====================

test("reduce: 完整流程投影正确（任务/决策/产物/交接/执行状态）", () => {
  const base = 1_700_000_000_000;
  const events = [
    { type: "run_started", sequence: 1, timestamp: base, runId: "run-1", task: "实现库存差异分析", entryAgentId: "leader" },
    { type: "task_created", sequence: 2, timestamp: base + 1, task: { id: "TASK-001", runId: "run-1", createdBy: "runtime", title: "分析需求", description: "需求拆解", assignedAgentId: "leader", status: "pending", createdAt: base + 1 } },
    { type: "execution_started", sequence: 3, timestamp: base + 2, execution: makeExecution("exec-1", "leader", 1, { taskIds: ["TASK-001"] }) },
    { type: "message_created", sequence: 4, timestamp: base + 3, message: { id: "msg-1", kind: "agent", executionId: "exec-1", agentId: "leader", role: "组长", content: "任务已拆解", createdAt: base + 3 } },
    { type: "artifact_produced", sequence: 5, timestamp: base + 4, artifact: { id: "art-1", path: "docs/plan.md", type: "file", createdBy: "leader", createdAt: base + 4, producedByExecutionId: "exec-1" } },
    { type: "decision_recorded", sequence: 6, timestamp: base + 5, decision: { id: "dec-1", content: "使用 Node 实现", madeBy: "leader", createdAt: base + 5 } },
    { type: "handoff_requested", sequence: 7, timestamp: base + 6, executionId: "exec-1", from: "leader", to: "product", kind: "transition", transitionId: "t1", reason: "方案设计" },
    { type: "execution_completed", sequence: 8, timestamp: base + 7, executionId: "exec-1", status: "completed", handoffTo: "product" },
    { type: "task_completed", sequence: 9, timestamp: base + 8, taskId: "TASK-001" },
    { type: "run_completed", sequence: 10, timestamp: base + 9, statusReason: { code: "completed", message: "入口角色收尾完成" } },
  ];

  const p = reduce(events);

  assert.equal(p.state.goal, "实现库存差异分析");
  assert.equal(p.state.phase, "planning");
  assert.equal(p.state.decisions.length, 1);
  assert.equal(p.state.decisions[0].madeBy, "leader");
  assert.equal(p.state.artifacts.length, 1);
  assert.equal(p.state.artifacts[0].producedByExecutionId, "exec-1");
  assert.deepEqual(p.state.completedTasks, ["TASK-001"]);
  assert.deepEqual(p.state.activeTasks, []);
  assert.deepEqual(p.state.lastHandoff, { from: "leader", to: "product", reason: "方案设计", executionId: "exec-1" });
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].content, "任务已拆解");
  assert.equal(p.executions.length, 1);
  assert.equal(p.executions[0].status, "completed");
  assert.equal(p.executions[0].handoffTo, "product");
  assert.equal(p.tasks[0].status, "completed");
});

test("reduce: 纯函数——同一事件序列两次 reduce 结果一致", () => {
  const events = [
    { type: "run_started", sequence: 1, timestamp: 1, runId: "r", task: "t", entryAgentId: "a" },
    { type: "steer", sequence: 2, timestamp: 2, agentId: "a", content: "请加快" },
  ];
  const a = reduce(events);
  const b = reduce(events);
  assert.deepEqual(a, b);
  assert.equal(a.messages[0].id, "steer-2"); // deterministic id
});

test("reduce: 空事件 → 空投影", () => {
  const p = reduce([]);
  assert.deepEqual(p, emptyProjections());
});

// ==================== EventStore ====================

test("EventStore: append 分配递增 sequence，replay 完整返回", (t) => {
  useTempDataDir(t);
  const store = new EventStore("sess-a", "run-1");
  const e1 = store.append({ type: "run_started", runId: "run-1", task: "任务", entryAgentId: "leader" });
  const e2 = store.append({ type: "message_created", message: { id: "m1", kind: "user", content: "hi", createdAt: 1 } });
  assert.equal(e1.sequence, 1);
  assert.equal(e2.sequence, 2);
  assert.ok(e1.timestamp > 0);

  const events = store.replay();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "run_started");
  assert.equal(events[1].sequence, 2);
});

test("EventStore: snapshot + 增量重放恢复（模拟崩溃恢复）", (t) => {
  useTempDataDir(t);
  const store = new EventStore("sess-b", "run-2");
  for (let i = 0; i < 52; i++) {
    store.append({ type: "message_created", message: { id: `m${i}`, kind: "user", content: `msg ${i}`, createdAt: i } });
  }
  const p = store.rebuildProjections(); // 无 snapshot：全量重放
  assert.equal(p.projections.messages.length, 52);
  assert.equal(p.eventSequence, 52);

  store.saveSnapshot(p.projections); // 落盘快照（模拟周期性快照）
  store.append({ type: "message_created", message: { id: "m52", kind: "user", content: "after snapshot", createdAt: 52 } });

  const rebuilt = store.rebuildProjections(); // 崩溃后重建：snapshot + 增量
  assert.equal(rebuilt.projections.messages.length, 53);
  assert.equal(rebuilt.projections.messages[52].content, "after snapshot");
  assert.equal(rebuilt.eventSequence, 53);
});

test("EventStore: 两个实例共享同一文件时 sequence 仍单调", (t) => {
  useTempDataDir(t);
  const a = new EventStore("sess-c", "run-3");
  const b = new EventStore("sess-c", "run-3");
  assert.equal(a.append({ type: "run_started", runId: "run-3", task: "t", entryAgentId: "x" }).sequence, 1);
  assert.equal(b.append({ type: "message_created", message: { id: "m", kind: "user", content: "x", createdAt: 1 } }).sequence, 2);
  assert.equal(a.append({ type: "message_created", message: { id: "m2", kind: "user", content: "y", createdAt: 2 } }).sequence, 3);
});

// ==================== TeamStore ====================

test("TeamStore: write/read/index/remove 生命周期", (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-1", "/tmp/work", "测试团队", "software-dev");

  TeamStore.write(team);
  const read = TeamStore.read("sess-1");
  assert.ok(read);
  assert.equal(read.entryAgentId, "leader");
  assert.equal(read.agents.length, 4);
  assert.equal(read.transitions.length, 7);

  TeamStore.upsertIndex("sess-1", { name: "测试团队", uiMode: "team" });
  assert.equal(TeamStore.list()["sess-1"].name, "测试团队");

  // 转回普通会话：uiMode 切换但数据保留
  TeamStore.upsertIndex("sess-1", { uiMode: "chat" });
  assert.equal(TeamStore.list()["sess-1"].uiMode, "chat");
  assert.ok(TeamStore.read("sess-1")); // team.json 仍在

  TeamStore.remove("sess-1");
  assert.equal(TeamStore.read("sess-1"), null);
  assert.equal(TeamStore.list()["sess-1"], undefined);
  assert.ok(!fs.existsSync(getTeamDir("sess-1")));
});

// ==================== 模板 ====================

test("模板: software-dev 生成完整角色与边", () => {
  assert.ok(TEAM_TEMPLATES.some((t) => t.id === "software-dev"));
  const team = createTeamDef("s", "/work", "n", "software-dev");
  assert.deepEqual(team.agents.map((a) => a.id), ["leader", "product", "developer", "tester"]);
  const testerOut = team.transitions.filter((t) => t.from === "tester");
  assert.equal(testerOut.length, 3); // 返工 + 通过 + 兜底
  assert.ok(testerOut.find((t) => t.trigger.condition?.mode === "keyword" && t.to === "developer"));
  assert.ok(testerOut.find((t) => t.trigger.condition?.mode === "keyword" && t.to === "leader"));
  assert.deepEqual(team.reworkEdges, [{ from: "tester", to: "developer" }]);
});
