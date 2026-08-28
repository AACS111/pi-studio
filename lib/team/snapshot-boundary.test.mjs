/**
 * 回归：EventStore 快照 + 增量合并不再丢任务状态更新。
 *
 * 背景：旧 rebuildProjections 对 delta 做「纯 concat 拼接」，跨快照边界
 * （每 50 个事件落一次快照）的 task_completed/task_failed/execution_completed
 * 更新全部丢失——delta 的 reduce 看不到 pre-snapshot 创建的任务对象，导致：
 *   - hasOpenTask() 永真 → no-progress 循环守卫失效（ping-pong 复发）
 *   - completeOpenTasksFor 反复补记完成事件
 *   - 上下文 DAG 出现幻影「进行中」任务
 *
 * 修复：TeamSnapshot 增加 v2 版本号；v2 投影用 reduce(delta, base) 在快照克隆上
 * 原地 apply（等价全量 replay）；v1 旧快照读取时作废、回退全量 replay 自愈。
 *
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/snapshot-boundary.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { EventStore, getSnapshotFile } = await import("./store.ts");
const { reduce } = await import("./types.ts");

/** 每个测试用独立临时数据目录（PI_WEB_UPLOADS_DIR 隔离） */
function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-snap-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
  return root;
}

/** 构造一个超过快照阈值的事件流：run_started + 根任务 + 49 条消息（共 51 个事件） */
function seed(store) {
  store.append({ type: "run_started", runId: "run-1", task: "T", entryAgentId: "developer" });
  store.append({
    type: "task_created",
    task: {
      id: "TASK-001", runId: "run-1", createdBy: "runtime", title: "根任务",
      description: "", assignedAgentId: "developer", status: "pending", createdAt: Date.now(),
    },
  });
  for (let i = 0; i < 48; i++) {
    store.append({ type: "message_created", message: { id: `m${i}`, kind: "agent", content: `msg-${i}`, createdAt: Date.now() } });
  }
}

/** 复刻 RunManager.append 在 sequence%50===0 时落快照的行为 */
function makeBoundarySnapshot(store) {
  const projections = store.rebuildProjections().projections;
  store.saveSnapshot(projections);
}

test("跨快照边界：边界之后的 task_completed 不再丢失（此前 tasks[0] 恒 pending）", (t) => {
  useTempDataDir(t);
  const store = new EventStore("sess-1", "run-1");
  seed(store);
  makeBoundarySnapshot(store); // 此刻 TASK-001 还是 pending —— 即旧版把「pending」固化的快照点
  assert.equal(store.loadSnapshot().eventSequence, 50);

  store.append({ type: "task_completed", taskId: "TASK-001" });

  const p = store.rebuildProjections().projections;
  assert.equal(p.tasks[0].status, "completed", "快照边界后的任务完成必须生效");
  assert.deepEqual(p.state.activeTasks, [], "activeTasks 必须移除已完成 id");
  assert.deepEqual(p.state.completedTasks, ["TASK-001"]);
});

test("跨快照边界：与全量 replay 结果完全一致", (t) => {
  useTempDataDir(t);
  const store = new EventStore("sess-2", "run-2");
  seed(store);
  makeBoundarySnapshot(store);
  // 边界之后三类更新事件都补一发
  store.append({ type: "handoff_requested", executionId: "e1", from: "developer", to: "tester", kind: "tool", reason: "交接" });
  store.append({ type: "task_failed", taskId: "TASK-001", reason: "验证不通过" });

  const rebuilt = store.rebuildProjections().projections;
  const fullReplay = reduce(store.replay());

  assert.equal(rebuilt.tasks[0].status, "failed");
  assert.equal(rebuilt.tasks[0].status, fullReplay.tasks[0].status);
  assert.deepEqual(rebuilt.state.activeTasks, fullReplay.state.activeTasks);
  assert.deepEqual(rebuilt.state.completedTasks, fullReplay.state.completedTasks);
  assert.deepEqual(rebuilt.messages.length, fullReplay.messages.length);
  assert.equal(rebuilt.state.lastHandoff?.to, "tester");
});

test("v1 旧快照（无版本字段）读取时作废：回退全量 replay 自愈历史脏投影", (t) => {
  useTempDataDir(t);
  const store = new EventStore("sess-3", "run-3");
  seed(store);
  makeBoundarySnapshot(store);
  // 模拟 v1 脏快照：手工抹掉版本字段（内容等价旧版产物——任务被固化成 pending）
  const snapFile = getSnapshotFile("sess-3", "run-3");
  const raw = JSON.parse(fs.readFileSync(snapFile, "utf8"));
  delete raw.v;
  fs.writeFileSync(snapFile, JSON.stringify(raw));

  store.append({ type: "task_completed", taskId: "TASK-001" });
  const p = store.rebuildProjections().projections;

  assert.equal(p.tasks[0].status, "completed", "脏快照应作废并自愈出正确状态");
  assert.deepEqual(p.state.activeTasks, []);
});
