/**
 * P0/P1 增强项验证：
 *  - P0-1 solo 降级（简单任务只跑入口角色）
 *  - P1-2 人工审批闸门（approval 边 → waiting_approval → approve/reject）
 *  - P1-1 结构化裁决（verdict 优先于 keyword）
 *  - P0-2/P0-4 上下文增强（期望产出/上一环节完整产出/共享任务列表）
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/enhance.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { RunManager } = await import("./runtime.ts");
const { EventStore } = await import("./store.ts");
const { createTeamDef } = await import("./templates.ts");
const { buildContext, buildAgentSystemPrompt } = await import("./context.ts");
const { classifyTask } = await import("./task-classify.ts");
const { emptyProjections } = await import("./types.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-enh-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
  return root;
}

function createMockExecutor(script) {
  const calls = [];
  return {
    calls,
    run: async ({ execution, onMessage }) => {
      calls.push({ agentId: execution.agentId, sequence: execution.sequence });
      const key = `${execution.agentId}#${execution.sequence}`;
      const entry = script[key];
      if (!entry) throw new Error(`no script for ${key}`);
      onMessage({
        id: `msg-${execution.id}`,
        kind: "agent",
        executionId: execution.id,
        agentId: execution.agentId,
        role: execution.agentId,
        content: entry.output,
        createdAt: Date.now(),
      });
      if (entry.verdict) {
        return { status: entry.status ?? "completed", output: entry.output, verdict: entry.verdict, failureReason: entry.failureReason };
      }
      return { status: entry.status ?? "completed", output: entry.output, failureReason: entry.failureReason };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRun(team, task, runId = "run-1", complexity) {
  return {
    id: runId,
    teamId: team.sessionId,
    status: "pending",
    task,
    // 默认 complex（多数测试需多角色链路）；solo 测试显式传 "simple"
    complexity: complexity ?? "complex",
    stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// —— P0-1：solo 降级 ——
test("solo 降级：autoSolo + 短任务 → 只跑入口角色即收尾", async (t) => {
  useTempDataDir(t);
  const team = { ...createTeamDef("sess-solo", "/w", "t", "software-dev"), autoSolo: true };
  const script = { "leader#1": { output: "已列出项目目录结构" } };
  const exec = createMockExecutor(script);
  const rm = new RunManager({ team, runId: "run-1", executor: exec });
  const run = await rm.execute(makeRun(team, "列出项目目录结构", "run-1", "simple"));
  assert.equal(run.status, "completed");
  assert.equal(run.stats.agentExecutions, 1, "solo 应只执行 1 次");
  assert.deepEqual(exec.calls.map((c) => c.agentId), ["leader"]);
});

test("solo 不误伤：autoSolo + 含复杂术语任务 → 走全链接力", async (t) => {
  useTempDataDir(t);
  const team = { ...createTeamDef("sess-solo2", "/w", "t", "software-dev"), autoSolo: true };
  const script = {
    "leader#1": { output: "开发任务" },
    "product#1": { output: "方案" },
    "developer#1": { output: "实现完成" },
    "tester#1": { output: "全部测试通过" },
    "leader#2": { output: "总结完成：最终结论：全部完成" },
  };
  const exec = createMockExecutor(script);
  const rm = new RunManager({ team, runId: "run-1", executor: exec });
  const run = await rm.execute(makeRun(team, "实现用户登录功能并完成测试"));
  assert.equal(run.status, "completed");
  assert.ok(run.stats.agentExecutions > 1, "复杂任务不应 solo");
});

// —— P1-1：结构化裁决 ——
test("结构化裁决：verdict:fail 优先于 keyword 命中返工边", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-vt", "/w", "t", "software-dev");
  const script = {
    "leader#1": { output: "派活" },
    "product#1": { output: "方案" },
    "developer#1": { output: "实现完成" },
    // tester 输出不含任何“问题/bug”词，但用 verdict:fail 明确判定失败 → 应返工开发
    "tester#1": { output: "已对照验收标准完成核对。", verdict: "fail" },
    "developer#2": { output: "已修复问题" },
    "tester#2": { output: "全部测试通过" },
    "leader#2": { output: "总结完成：最终结论：任务完成" },
  };
  const exec = createMockExecutor(script);
  const rm = new RunManager({ team, runId: "run-1", executor: exec });
  const run = await rm.execute(makeRun(team, "验证结构化路由"));
  assert.equal(run.status, "completed");
  const seq = exec.calls.map((c) => `${c.agentId}#${c.sequence}`);
  // tester#1 之后应为 developer#2（返工），即使输出无关键词
  const testerIdx = seq.indexOf("tester#1");
  assert.equal(seq[testerIdx + 1], "developer#2", "verdict:fail 应命中返工边");
  assert.equal(run.stats.reworkCount, 1);
});

// —— P1-2：人工审批闸门 ——
function approvalTeam() {
  return {
    ...createTeamDef("sess-appr", "/w", "t", "software-dev"),
    defaultRoutingMode: "strict",
    agents: [
      { id: "leader", name: "组长", role: "组长", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
      { id: "product", name: "产品", role: "产品", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } },
    ],
    transitions: [
      { id: "l-p", from: "leader", to: "product", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true, approval: true },
      { id: "p-end", from: "product", to: "__end__", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
    ],
    reworkEdges: [],
  };
}

test("审批闸门：approval 边 → waiting_approval，批准后继续", async (t) => {
  useTempDataDir(t);
  const team = approvalTeam();
  const script = {
    "leader#1": { output: "拆解完成" },
    "product#1": { output: "方案完成" },
  };
  const exec = createMockExecutor(script);
  const runStates = [];
  const rm = new RunManager({ team, runId: "run-1", executor: exec, onRunUpdate: (r) => runStates.push(r.status) });
  const promise = rm.execute(makeRun(team, "审批测试"));
  await sleep(30);
  assert.ok(runStates.includes("waiting_approval"), `应出现 waiting_approval，实际 ${runStates.join(",")}`);
  // 暂停时不执行下游角色
  assert.deepEqual(exec.calls.map((c) => c.agentId), ["leader"], "批准前不应执行下游");
  rm.approve();
  const final = await promise;
  assert.equal(final.status, "completed");
  assert.ok(exec.calls.some((c) => c.agentId === "product"), "批准后应执行 product");
  // 事件流包含 approval_requested / approval_resolved
  const events = new EventStore(team.sessionId, "run-1").replay();
  assert.ok(events.some((e) => e.type === "approval_requested"));
  assert.ok(events.some((e) => e.type === "approval_resolved" && e.approved === true));
});

test("审批闸门：reject 驳回 → 运行取消", async (t) => {
  useTempDataDir(t);
  const team = approvalTeam();
  const script = { "leader#1": { output: "拆解完成" } };
  const exec = createMockExecutor(script);
  const rm = new RunManager({ team, runId: "run-1", executor: exec });
  const promise = rm.execute(makeRun(team, "审批驳回测试"));
  await sleep(30);
  rm.reject();
  const final = await promise;
  assert.equal(final.status, "cancelled");
  assert.equal(runState(final), "cancelled");
  assert.equal(final.statusReason?.code, "user_cancelled");
  // 驳回后不再执行 product
  assert.deepEqual(exec.calls.map((c) => c.agentId), ["leader"]);
});

function runState(run) {
  return run.status;
}

// —— P0-2/P0-4：上下文增强 ——
test("上下文增强：期望产出 + 上一环节完整产出 + 共享任务列表", () => {
  const team = createTeamDef("sess-ctx", "/w", "t", "software-dev");
  void team;
  const agent = { id: "developer", name: "开发", role: "开发", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" }, expectation: "实现功能并跑通测试" };
  const projections = emptyProjections();
  projections.tasks.push({ id: "TASK-001", runId: "r1", createdBy: "leader", title: "实现登录", description: "", assignedAgentId: "developer", status: "running", parentTaskId: undefined, dependsOn: ["TASK-000"], createdAt: Date.now() });
  projections.messages.push(
    { id: "m1", kind: "user", content: "用户任务：做登录", createdAt: Date.now() },
    { id: "m2", kind: "agent", agentId: "product", role: "产品", content: "方案：登录用邮箱+密码，遵循 RFC 规范……这是产品经理的完整方案全文，包含多行细节。", createdAt: Date.now() },
  );
  projections.state.goal = "做登录";
  projections.state.phase = "implementation";
  projections.state.completedTasks = [];
  projections.state.activeTasks = ["TASK-001"];
  projections.state.decisions = [];
  projections.state.blockers = [];
  projections.state.artifacts = [];

  const ctx = buildContext({ team, run: { id: "r1", teamId: "sess-ctx", status: "running", task: "做登录", stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 }, createdAt: Date.now(), updatedAt: Date.now() }, projections, agent });

  assert.ok(ctx.includes("本角色期望产出"), "应出现期望产出块");
  assert.ok(ctx.includes("实现功能并跑通测试"), "期望产出内容注入");
  assert.ok(ctx.includes("前序角色摘要"), "应出现前序角色摘要块（含 trace 指针）");
  assert.ok(ctx.includes("产品"), "前序摘要应含产品角色");
  assert.ok(ctx.includes("共享任务列表"), "应出现共享任务列表块");
  assert.ok(ctx.includes("TASK-001"), "任务 DAG 透出");
  assert.ok(ctx.includes("TASK-000"), "任务依赖透出");
  // systemPrompt 拼接上下文
  const full = buildAgentSystemPrompt(agent, ctx);
  assert.ok(full.includes("项目组工作上下文"));
});

// —— 每角色一份总结 .md：buildContext 读取它作为前置总结，并给出思考 .jsonl 指针 ——
test("上下文增强：前序总结读自每角色 summary .md + 思考会话 .jsonl 指针", (t) => {
  const root = useTempDataDir(t);
  const team = createTeamDef("sess-sum", "/w", "t", "software-dev");
  const agent = { id: "developer", name: "开发", role: "开发", model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } };
  const projections = emptyProjections();
  // 消息正文写得与总结不同，用于证明「优先读 summary .md 而不是消息内容」
  projections.messages.push({ id: "m1", kind: "agent", agentId: "product", role: "产品", content: "（这条消息内容不应被当成总结）", createdAt: Date.now() });
  // 写一个「每角色一份」的 product 总结 .md（含最后一次执行的结论段）
  const sumDir = path.join(root, ".internal", "teams", "sess-sum", "runs", "r1", "summaries");
  fs.mkdirSync(sumDir, { recursive: true });
  fs.writeFileSync(path.join(sumDir, "product.md"), [
    "# 角色总结：产品（product）",
    "> 思考/会话全文：sessions/r1-product.jsonl（下游角色按需 read）",
    "",
    "---",
    "## 执行 #1",
    "- 状态：完成",
    "- 结论：方案确定用邮箱+密码，遵循 RFC 规范",
  ].join("\n"), "utf8");

  const ctx = buildContext({
    team,
    run: { id: "r1", teamId: "sess-sum", status: "running", task: "做登录", stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 }, createdAt: Date.now(), updatedAt: Date.now() },
    projections,
    agent,
  });

  assert.ok(ctx.includes("方案确定用邮箱+密码"), "前序总结应读自 product 的 summary .md（而非消息内容）");
  assert.ok(ctx.includes("总结: summaries/product.md"), "应给出总结 .md 指针");
  assert.ok(ctx.includes("思考/会话: sessions/r1-product.jsonl"), "应给出思考/会话 .jsonl 指针");
});
