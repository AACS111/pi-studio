/**
 * 阶段 1 修复回归（2026-08-28，参考 pi 社区四仓设计适配）：
 *   ① NaN 保险丝兜底——team.json 缺 maxHops/maxReworkRounds/maxRunMinutes 时构造函数显式兜底，
 *      computeExecutionTimeoutMs 对 NaN maxRunMinutes 返回有效超时（旧实现 setTimeout(NaN)≈立即超时
 *      → 每次执行瞬间失败 → hybrid 兜底回入口 → CPU 速度死循环刷盘）
 *   ② steer 字段修复 + 三段式软着陆——rpc 层读 command.message（旧实现发 text → steer(undefined)
 *      抛 TypeError → 静默 abort 整个回合）；steer 失败不再 abort，宽限 N 回合耗尽才强制中断，
 *      中断结局标注「回合上限强制中断」而非误判「模型调用失败」
 *   ③ 网关推迟解析——parallel 分叉产出 [A, gw] 且存在 A→gw 边时，gw 必须等 A 终态才消费
 *      （旧实现提前用过期 lastOutput 路由 + A feed 后二次消费 → 下游重复执行）
 *   ④ 单分支编排异常隔离——Promise.all → allSettled，单分支异常不击穿 pump（兄弟分支继续、
 *      事件流终态正常落盘）
 *
 * 运行：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/team/fixes-regression.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { RunManager } = await import("./runtime.ts");
const { EventStore } = await import("./store.ts");
const { PiAgentExecutor } = await import("./executor.ts");
const { computeExecutionTimeoutMs } = await import("./executor.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-fixreg-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
  return root;
}

const now = Date.now();
const agent = (id, name, role) => ({ id, name, role, model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } });

function makeRun(task) {
  return {
    id: "run-1",
    teamId: "sess-fixreg",
    status: "pending",
    task,
    stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** mock 执行器：按脚本返回输出（可带 delayMs） */
function createScriptExecutor(script) {
  const calls = [];
  return {
    calls,
    run: async ({ execution, onMessage }) => {
      calls.push({ agentId: execution.agentId, sequence: execution.sequence });
      const key = `${execution.agentId}#${execution.sequence}`;
      const entry = script[key];
      if (!entry) throw new Error(`no script for ${key}`);
      if (entry.delayMs) await new Promise((r) => setTimeout(r, entry.delayMs));
      if (entry.throw) throw new Error(entry.throw);
      if (entry.onMessage) onMessage({
        id: `msg-${execution.id}`,
        kind: "agent",
        executionId: execution.id,
        agentId: execution.agentId,
        role: execution.agentId,
        content: entry.onMessage,
        createdAt: Date.now(),
      });
      return { status: entry.status ?? "completed", output: entry.output ?? "" };
    },
  };
}

/* ==================== ① NaN 保险丝兜底 ==================== */

test("① RunManager 构造：缺 maxHops/maxReworkRounds/maxRunMinutes 时显式兜底（旧实现三条保险丝全失效）", async () => {
  const team = {
    sessionId: "sess-nan", name: "缺字段团队", cwd: "/w", entryAgentId: "leader",
    agents: [agent("leader", "组长", "组长")],
    transitions: [{ id: "t0", from: "leader", to: "__end__", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true }],
    defaultRoutingMode: "strict",
    createdAt: now, updatedAt: now,
  };
  const rm = new RunManager({ team, runId: "run-nan", executor: { run: async () => ({ status: "completed", output: "" }) } });
  const t2 = rm.team;
  assert.equal(t2.maxHops, 40, "maxHops 缺失应兜底 40");
  assert.equal(t2.maxReworkRounds, 3, "maxReworkRounds 缺失应兜底 3");
  assert.equal(t2.maxRunMinutes, 30, "maxRunMinutes 缺失应兜底 30");
  // 不污染调用方传入的对象
  assert.equal(team.maxHops, undefined, "兜底应作用在副本上，不改调用方对象");
});

test("① computeExecutionTimeoutMs：NaN maxRunMinutes 兜底为有效超时（旧实现返回 NaN → setTimeout 立即触发）", async () => {
  const ms = computeExecutionTimeoutMs({ maxRunMinutes: undefined, agentCount: 3 });
  assert.ok(Number.isFinite(ms), `NaN maxRunMinutes 应兜底出有限超时，实际 ${ms}`);
  assert.ok(ms > 60_000, `兜底超时应 ≥ 1 分钟，实际 ${ms}ms`);
  assert.equal(computeExecutionTimeoutMs({ maxRunMinutes: 5, agentCount: 3 }), Math.floor(5 * 60_000 * 0.75 / 2), "正常值行为不变");
});

/* ==================== ② steer 字段 + 三段式软着陆 ==================== */

/** mock 会话：可控发射 tool_execution_start 事件流，记录 steer/abort 调用 */
function makeTurnLimitSessionFactory(opts, state) {
  return async (sessionId) => {
    let handler;
    const session = {
      inner: {
        model: { id: "fake", provider: "mock" },
        prompt: async () => {
          // 发射 turns + extraTools 次工具事件；宽限耗尽用例用 turns + grace + 2 覆盖第二个阈值
          for (let i = 0; i < opts.turns + (opts.extraTools ?? opts.grace + 2); i++) {
            handler?.({ type: "tool_execution_start", toolName: "read", args: { path: `f${i}.ts` } });
            await new Promise((r) => setTimeout(r, 1));
          }
          return {};
        },
      },
      waitUntilReady: async () => {},
      onEvent: (h) => { handler = h; return () => { handler = undefined; }; },
      send: async (cmd) => {
        switch (cmd?.type) {
          case "steer":
            state.steers.push(cmd);
            if (opts.steerFails) throw new TypeError("steer 注入失败（模拟旧字段 bug 场景）");
            return undefined;
          case "abort":
            state.aborts++;
            return undefined;
          case "get_session_stats":
            return { tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 }, cost: 0, userMessages: 1, assistantMessages: 1, toolCalls: 1, toolResults: 1, totalMessages: 2 };
          case "get_last_assistant_text":
            return { text: opts.finalOutput ?? "" };
          default:
            return undefined;
        }
      },
      shutdown: async () => {},
    };
    return { session, realSessionId: sessionId };
  };
}

function makeSingleAgentTeam() {
  return {
    sessionId: "sess-turnlimit", name: "回合上限", cwd: "/w", entryAgentId: "leader",
    agents: [agent("leader", "组长", "组长")],
    transitions: [{ id: "t0", from: "leader", to: "__end__", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true }],
    defaultRoutingMode: "strict",
    maxHops: 30, maxReworkRounds: 3, maxRunMinutes: 5,
    contextScope: "structured", recentCount: 20,
    createdAt: now, updatedAt: now,
  };
}

const baseExecution = {
  id: "exec-tl-1", runId: "run-tl-1", agentId: "leader", sequence: 1,
  status: "running", startedAt: Date.now(), sessionId: "run-tl-1-leader", sessionPath: "/tmp/x.jsonl",
};

test("② steer 走 message 字段且成功时不再 abort 整个回合（旧实现字段错→静默 abort）", async (t) => {
  useTempDataDir(t);
  const state = { steers: [], aborts: 0 };
  const team = makeSingleAgentTeam();
  const executor = new PiAgentExecutor(makeTurnLimitSessionFactory({ turns: 60, grace: 5, extraTools: 2, finalOutput: "已收尾总结" }, state));
  const result = await executor.run({
    team, runId: "run-tl-1", execution: baseExecution,
    context: "任务", task: "任务", existingTasks: [], mode: "orchestrated",
    signal: new AbortController().signal, onEvent: () => {}, onMessage: () => {},
  });
  assert.equal(state.aborts, 0, "steer 成功送达时不应 abort（收尾靠 LLM 自身）");
  assert.equal(state.steers.length, 1, "恰好一条 steer 收尾指令");
  assert.equal(typeof state.steers[0]?.message, "string", "steer 必须走 message 字段（rpc 层读 command.message，旧 text 字段会导致 steer(undefined)）");
  assert.ok(state.steers[0].message.includes("回合上限"), "steer 内容应为收尾指令");
  assert.equal(result.status, "completed", `宽限回合内收尾应正常完成，实际 ${result.status}: ${result.failureReason ?? ""}`);
});

test("② steer 失败不再静默 abort 整个执行（旧实现 .catch(abortExecution)）", async (t) => {
  useTempDataDir(t);
  const state = { steers: [], aborts: 0 };
  const team = makeSingleAgentTeam();
  const executor = new PiAgentExecutor(makeTurnLimitSessionFactory({ turns: 60, grace: 5, extraTools: 2, steerFails: true, finalOutput: "仍然收尾了" }, state));
  const result = await executor.run({
    team, runId: "run-tl-2", execution: baseExecution,
    context: "任务", task: "任务", existingTasks: [], mode: "orchestrated",
    signal: new AbortController().signal, onEvent: () => {}, onMessage: () => {},
  });
  assert.equal(state.steers.length, 1, "steer 被调用过");
  assert.equal(state.aborts, 0, "steer 失败不应 abort（宽限回合内继续，靠后续兜底）");
  assert.equal(result.status, "completed", `执行不应被 steer 失败连坐，实际 ${result.status}: ${result.failureReason ?? ""}`);
});

test("② 宽限耗尽强制中断：结局标注「回合上限强制中断」而非误判「模型调用失败」", async (t) => {
  useTempDataDir(t);
  const state = { steers: [], aborts: 0 };
  const team = makeSingleAgentTeam();
  const executor = new PiAgentExecutor(
    // turns=3：3 次工具后 steer；grace=5：第 8 次工具后强制中断；最终输出为空
    makeTurnLimitSessionFactory({ turns: 3, grace: 5, finalOutput: "" }, state),
  );
  // 临时压低 maxTurns：给 agent 配 maxTurns=3
  team.agents[0].maxTurns = 3;
  const result = await executor.run({
    team, runId: "run-tl-3", execution: baseExecution,
    context: "任务", task: "任务", existingTasks: [], mode: "orchestrated",
    signal: new AbortController().signal, onEvent: () => {}, onMessage: () => {},
  });
  assert.equal(state.steers.length, 1, "达到上限时发过一次 steer");
  assert.ok(state.aborts >= 1, "宽限耗尽应强制中断");
  assert.equal(result.status, "failed");
  assert.match(result.failureReason ?? "", /回合上限/, `failureReason 应标注回合上限强制中断，实际：${result.failureReason}`);
  assert.doesNotMatch(result.failureReason ?? "", /模型调用失败/, "不得误判为模型调用失败（stopReason=aborted 不是 provider 错误）");
});

test("⑤ solo 入口角色写权限提升：leader writePolicy=docs 不再没收 edit/write（旧 bug：solo 改不了代码）", async (t) => {
  useTempDataDir(t);
  const state = { steers: [], aborts: 0 };
  const captured = { toolNames: [] };
  const inner = makeTurnLimitSessionFactory({ turns: 60, grace: 5, extraTools: 0, finalOutput: "solo 完成" }, state);
  const factory = async (sessionId, sessionFile, cwd, opts) => {
    captured.toolNames = opts?.toolNames ?? [];
    return inner(sessionId);
  };
  const team = makeSingleAgentTeam();
  team.agents[0].writePolicy = "docs"; // 软件研发模板的 leader 显式 docs（library.ts:51）
  const executor = new PiAgentExecutor(factory);
  const result = await executor.run({
    team, runId: "run-solo-tools", execution: baseExecution,
    context: "任务", task: "改一个bug", existingTasks: [], mode: "solo",
    signal: new AbortController().signal, onEvent: () => {}, onMessage: () => {},
  });
  assert.ok(captured.toolNames.includes("edit"), `solo 入口必须含 edit，实际：${captured.toolNames.join(",")}`);
  assert.ok(captured.toolNames.includes("write"), `solo 入口必须含 write，实际：${captured.toolNames.join(",")}`);
  assert.equal(result.status, "completed");
});

/* ==================== ⑥ 超时兑底不依赖 abort 完成 ==================== */

test("⑥ withTimeout：onTimeout（send abort）pending 时也立即 reject（旧实现永不 reject）", async () => {
  const { withTimeout } = await import("./executor.ts");
  const hangOnTimeout = () => new Promise(() => {}); // 模拟底层会话 hang 死，abort 命令自身 pending
  const start = Date.now();
  await assert.rejects(
    withTimeout(new Promise(() => {}), 60, hangOnTimeout),
    /执行超时/,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `超时应立即 reject（~60ms），实际 ${elapsed}ms（旧实现会 pending 卡死）`);
});

/* ==================== ③ 网关推迟到全波成员终态 ==================== */

test("③ 网关推迟：parallel 分叉 [A, gw] 且存在 A→gw 边时，gw 等 A 跑完才消费一次（旧实现提前消费+二次消费）", async (t) => {
  useTempDataDir(t);
  const team = {
    sessionId: "sess-gwdefer", name: "网关推迟", cwd: "/w", entryAgentId: "leader",
    agents: [
      agent("leader", "组长", "组长"),
      agent("dev-a", "开发A", "开发"),
      agent("tester", "测试", "测试"),
      agent("reviewer", "兜底评审", "评审"),
    ],
    transitions: [
      { id: "t0", from: "leader", to: "gw-split", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      // parallel 分叉：一个分支是 agent，另一个分支直接是下游网关（custom 画布合法结构）
      { id: "s-a", from: "gw-split", to: "dev-a", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "s-g", from: "gw-split", to: "gw-check", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      // 关键边：A → gw-check（gw-check 的输入必须等 A）
      { id: "t-ag", from: "dev-a", to: "gw-check", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      // gw-check：关键词只在 A 的输出里 → tester；always 兜底 → reviewer（旧实现提前消费走这里）
      { id: "c-ok", from: "gw-check", to: "tester", priority: 10, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["A模块验收通过"] } }, enabled: true },
      { id: "c-fb", from: "gw-check", to: "reviewer", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "t-te", from: "tester", to: "__end__", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "t-re", from: "reviewer", to: "__end__", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
    ],
    gateways: [
      { id: "gw-split", type: "parallel", name: "并行扇出" },
      { id: "gw-check", type: "exclusive", name: "验收网关" },
    ],
    defaultRoutingMode: "strict",
    maxHops: 30, maxReworkRounds: 3, maxRunMinutes: 5,
    contextScope: "structured", recentCount: 20,
    createdAt: now, updatedAt: now,
  };
  const executor = createScriptExecutor({
    "leader#1": { output: "任务拆解" },
    // A 延迟 40ms：保证旧实现在它跑完前就把 gw-check 消费掉
    "dev-a#1": { output: "A模块验收通过", delayMs: 40 },
    "tester#1": { output: "测试完成" },
  });
  const rm = new RunManager({ team, runId: "run-gwdefer", executor });
  const finalRun = await rm.execute(makeRun("网关推迟回归"));
  assert.equal(finalRun.status, "completed", `run 应正常完成，实际 ${finalRun.status}: ${finalRun.statusReason?.message ?? ""}`);
  const testerCalls = executor.calls.filter((c) => c.agentId === "tester");
  const reviewerCalls = executor.calls.filter((c) => c.agentId === "reviewer");
  assert.equal(testerCalls.length, 1, `tester 应恰好执行一次（旧实现会被二次消费拖成 2 次），实际 ${testerCalls.length}`);
  assert.equal(reviewerCalls.length, 0, `gw-check 提前消费时会走 always 兜底到 reviewer（旧 bug 信号），实际执行 ${reviewerCalls.length} 次`);
});

/* ==================== ④ 单分支编排异常隔离 ==================== */

test("④ 单分支 launchAgent 异常不击穿 pump：兄弟分支继续、run 正常终态、警告落盘", async (t) => {
  useTempDataDir(t);
  const team = {
    sessionId: "sess-brancherr", name: "分支隔离", cwd: "/w", entryAgentId: "leader",
    agents: [
      agent("leader", "组长", "组长"),
      agent("dev-a", "开发A", "开发"),
      agent("dev-b", "开发B", "开发"),
      agent("tester", "测试", "测试"),
    ],
    transitions: [
      { id: "t0", from: "leader", to: "gw-split", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "s-a", from: "gw-split", to: "dev-a", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "s-b", from: "gw-split", to: "dev-b", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "t-a", from: "dev-a", to: "tester", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "t-b", from: "dev-b", to: "tester", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "t-te", from: "tester", to: "__end__", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
    ],
    gateways: [{ id: "gw-split", type: "merge", name: "双分支汇聚" }],
    defaultRoutingMode: "strict",
    maxHops: 30, maxReworkRounds: 3, maxRunMinutes: 5,
    contextScope: "structured", recentCount: 20,
    createdAt: now, updatedAt: now,
  };
  const executor = createScriptExecutor({
    "leader#1": { output: "拆解" },
    "dev-a#1": { output: "A完成" },
    "dev-b#1": { output: "B完成", delayMs: 20 },
    "tester#1": { output: "测试完成" },
  });
  const rm = new RunManager({ team, runId: "run-brancherr", executor });
  // 打桩：dev-a 分支在编排层抛异常（模拟 append/resolveRoute/approval 层异常击穿旧 Promise.all）
  const origLaunch = rm.launchAgent.bind(rm);
  rm.launchAgent = async (nodeId) => {
    if (nodeId === "dev-a") throw new Error("编排层异常模拟：resolveRoute 抛错");
    return origLaunch(nodeId);
  };
  const finalRun = await rm.execute(makeRun("分支隔离回归"));
  assert.equal(finalRun.status, "completed", `dev-a 异常不应拖垮整场（dev-b/tester 继续），实际 ${finalRun.status}: ${finalRun.statusReason?.message ?? ""}`);
  assert.ok(executor.calls.some((c) => c.agentId === "dev-b"), "兄弟分支 dev-b 应已执行");
  assert.ok(executor.calls.some((c) => c.agentId === "tester"), "下游 tester 应已执行");
  // 事件流应有隔离警告（系统消息），且终态事件正常落盘
  const events = new EventStore(team.sessionId, "run-brancherr").replay();
  const warn = events.find((e) => e.type === "message_created" && String(e.message?.content ?? "").includes("dev-a") && String(e.message?.content ?? "").includes("编排异常"));
  assert.ok(warn, "应有一条 dev-a 分支编排异常的可见警告");
  assert.ok(events.some((e) => e.type === "run_completed"), "事件流应正常落 run_completed 终态（重开页面不再永远 running）");
});
