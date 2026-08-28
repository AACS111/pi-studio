/**
 * Phase 1A Step4 验证：受控工具集（校验 + sink 收集 + 事件消费）。
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/tools.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { createTeamTools, createToolSink, consumeToolRequests } = await import("./tools.ts");
const { createTeamDef } = await import("./templates.ts");

const TEAM = createTeamDef("sess-1", "/work", "t", "software-dev");

async function runTool(name, params, options) {
  const tools = createTeamTools(options);
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.execute("tc1", params, undefined, undefined, undefined);
}

test("createTeamTools: 生成 5 个受控工具", () => {
  const sink = createToolSink();
  const tools = createTeamTools({ team: TEAM, executingAgentId: "tester", existingTasks: [], sink });
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "team_add_artifact",
    "team_complete_task",
    "team_create_task",
    "team_handoff",
    "team_record_decision",
  ]);
});

test("handoff 校验: self-loop / 目标不存在 / 白名单", async () => {
  const sink = createToolSink();
  const team = { ...TEAM, agents: TEAM.agents.map((a) => (a.id === "tester" ? { ...a, handoffPolicy: { allowedTargets: ["developer", "leader"] } } : a)) };
  const opts = { team, executingAgentId: "tester", existingTasks: [], sink };

  // self-loop 拒绝
  let r = await runTool("team_handoff", { to: "tester", summary: "自己" }, opts);
  assert.equal(sink.requests.length, 0);
  assert.match(r.content[0].text, /不能交接给自己/);

  // 目标不存在拒绝
  r = await runTool("team_handoff", { to: "ghost", summary: "x" }, opts);
  assert.match(r.content[0].text, /不存在/);

  // 白名单外拒绝
  r = await runTool("team_handoff", { to: "product", summary: "x" }, opts);
  assert.match(r.content[0].text, /只允许交接给/);
  assert.equal(sink.requests.length, 0);

  // 合法通过
  r = await runTool("team_handoff", { to: "developer", summary: "发现问题清单", artifacts: ["docs/bugs.md"] }, opts);
  assert.ok(!/错误/.test(r.content[0].text));
  assert.equal(sink.requests.length, 1);
  assert.deepEqual(sink.requests[0], { kind: "handoff", to: "developer", summary: "发现问题清单", artifacts: ["docs/bugs.md"], blockers: undefined });
});

test("create_task / complete_task / add_artifact / record_decision 校验", async () => {
  const sink = createToolSink();
  const opts = { team: TEAM, executingAgentId: "developer", existingTasks: [{ id: "TASK-001", title: "实现功能" }], sink };

  // 空 title 拒绝
  await runTool("team_create_task", { title: "  " }, opts);
  assert.equal(sink.requests.length, 0);
  // assignedAgentId 不存在拒绝
  await runTool("team_create_task", { title: "t", assignedAgentId: "nobody" }, opts);
  assert.equal(sink.requests.length, 0);
  // 合法
  await runTool("team_create_task", { title: "重构模块", assignedAgentId: "developer" }, opts);
  assert.equal(sink.requests.length, 1);

  // complete_task: 不存在拒绝
  await runTool("team_complete_task", { taskId: "TASK-999" }, opts);
  assert.equal(sink.requests.length, 1);
  // 存在通过
  await runTool("team_complete_task", { taskId: "TASK-001" }, opts);
  assert.equal(sink.requests.length, 2);

  // add_artifact: 空 path 拒绝
  await runTool("team_add_artifact", { path: "" }, opts);
  assert.equal(sink.requests.length, 2);
  await runTool("team_add_artifact", { path: "src/App.tsx", description: "重构后入口" }, opts);
  assert.equal(sink.requests.length, 3);

  // record_decision: 空 content 拒绝
  await runTool("team_record_decision", { content: "" }, opts);
  assert.equal(sink.requests.length, 3);
  await runTool("team_record_decision", { content: "采用 TypeScript 严格模式" }, opts);
  assert.equal(sink.requests.length, 4);
});

test("consumeToolRequests: 请求 → 事件（task/artifact/decision/handoff）", () => {
  const events = [];
  const sink = createToolSink();
  sink.requests.push(
    { kind: "create_task", title: "写测试", assignedAgentId: "tester" },
    { kind: "add_artifact", path: "docs/report.md", type: "file", description: "验证报告" },
    { kind: "record_decision", content: "用 SQLite" },
    { kind: "handoff", to: "leader", summary: "完成" },
  );
  const out = consumeToolRequests(sink, "exec-1", "tester", "run-1", (e) => events.push(e));

  assert.ok(out.handoff);
  assert.equal(out.handoff.to, "leader");
  assert.equal(out.taskRequests, 1);
  assert.equal(out.artifactRequests, 1);
  assert.equal(out.decisionRequests, 1);

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["task_created", "artifact_produced", "decision_recorded"]);
  const task = events[0];
  assert.equal(task.task.createdBy, "tester");
  assert.match(task.task.id, /^TASK-\d{3}$/);
  const art = events[1];
  assert.equal(art.artifact.producedByExecutionId, "exec-1");
  assert.equal(art.artifact.createdBy, "tester");
  const dec = events[2];
  assert.equal(dec.decision.madeBy, "tester");
});

// ==================== 回归：to=__end__ 放行 + 任务编号防撞 ====================

test("team_handoff: to=__end__ 是协议终态而非角色，必须放行进 sink（此前被误拒）", async () => {
  const sink = createToolSink();
  const opts = { team: TEAM, executingAgentId: "leader", existingTasks: [], sink };
  const res = await runTool("team_handoff", { to: "__end__", summary: "任务全部完成并交付" }, opts);
  assert.equal(sink.requests.length, 1, "合法的 __end__ 交接必须进入 sink");
  assert.equal(sink.requests[0].kind, "handoff");
  assert.equal(sink.requests[0].to, "__end__");
  const text = String(res.content?.[0]?.text ?? "");
  assert.ok(!text.includes("不存在"), "不得再报「目标角色 __end__ 不存在」");
});

test("create_task: 编号从现有任务（含 Runtime 根任务 TASK-001）之上分配，不撞号", async () => {
  const rootTask = {
    id: "TASK-001", runId: "run-1", createdBy: "runtime", title: "用户发布的任务",
    description: "", assignedAgentId: "leader", status: "pending", createdAt: Date.now(),
  };
  const events = [];
  const sink = createToolSink();
  const opts = { team: TEAM, executingAgentId: "leader", existingTasks: [rootTask], sink };
  const tools = createTeamTools(opts);
  const create = tools.find((t) => t.name === "team_create_task");
  await create.execute("tc1", { title: "分析需求" }, undefined, undefined, undefined);
  await create.execute("tc2", { title: "实现功能" }, undefined, undefined, undefined);
  consumeToolRequests(sink, "exec-1", "leader", "run-1", (e) => events.push(e));
  const ids = events.filter((e) => e.type === "task_created").map((e) => e.task.id);
  assert.equal(ids.length, 2, "两次建任务都应生效");
  assert.ok(!ids.includes("TASK-001"), `角色自建任务不得与根任务撞号，实际：${ids.join(", ")}`);
  assert.equal(new Set(ids).size, ids.length, "彼此也不得重复");
});
