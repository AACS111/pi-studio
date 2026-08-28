/**
 * 回归：并行波次下 exclusive 网关判定输入的竞态修复。
 *
 * 背景：旧实现 launchAgent 完成时把 result.output 写进全局共享 this.lastOutput，
 * Promise.all 并发完成顺序不定 → 网关拿到「全局最后完成者」的输出，而非
 * 「到达该网关的分支」的聚合输出。若带关键字的分支先完成、无关键字分支后完成，
 * 排他网关会误判走错分支（落到 always 兜底边）。
 *
 * 修复：gatewayInputs 聚合「自上次消费以来到达该网关的所有分支输出」后再消费。
 *
 * 本测试构造：leader 经 parallel 网关扇出 dev-a / dev-b（B 延迟 40ms 保证最后
 * 完成）→ 汇入 exclusive 网关 → 关键字「验收通过」（只在 A 的输出里，priority 10）
 * 应赢过 always 兜底边（priority 0）。旧代码此处会落到 reviewer 兜底分支。
 *
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/gateway-race.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { RunManager } = await import("./runtime.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-gwrace-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
  return root;
}

/** mock 执行器：支持 delayMs 控制完成先后（复现共享 lastOutput 的覆盖顺序） */
function createDelayedExecutor(script) {
  const calls = [];
  return {
    calls,
    run: async ({ execution, onMessage }) => {
      calls.push({ agentId: execution.agentId, sequence: execution.sequence });
      const key = `${execution.agentId}#${execution.sequence}`;
      const entry = script[key];
      if (!entry) throw new Error(`no script for ${key}`);
      if (entry.delayMs) await new Promise((r) => setTimeout(r, entry.delayMs));
      onMessage({
        id: `msg-${execution.id}`,
        kind: "agent",
        executionId: execution.id,
        agentId: execution.agentId,
        role: execution.agentId,
        content: entry.output,
        createdAt: Date.now(),
      });
      return { status: entry.status ?? "completed", output: entry.output };
    },
  };
}

const now = Date.now();
const agent = (id, name, role) => ({ id, name, role, model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" } });

function makeTeam() {
  return {
    sessionId: "sess-gwrace",
    name: "网关竞态",
    cwd: "/work",
    entryAgentId: "leader",
    agents: [
      agent("leader", "组长", "项目组长"),
      agent("dev-a", "开发A", "开发"),
      agent("dev-b", "开发B", "开发"),
      agent("tester", "测试", "测试"),
      agent("reviewer", "评审", "评审兜底"),
    ],
    transitions: [
      // leader → parallel 扇出网关 → 双分支并行 → 汇入 exclusive 判定网关
      { id: "t0", from: "leader", to: "gw-split", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "s-a", from: "gw-split", to: "dev-a", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "s-b", from: "gw-split", to: "dev-b", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "t-ag", from: "dev-a", to: "gw", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "t-bg", from: "dev-b", to: "gw", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      // 关键词只在 A 的输出里；B 后完成但输出不含关键词 —— 旧实现会因共享 lastOutput 被 B 覆盖而漏判
      { id: "t-ok", from: "gw", to: "tester", priority: 10, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["验收通过"] } }, enabled: true },
      { id: "t-fb", from: "gw", to: "reviewer", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "t-te", from: "tester", to: "__end__", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      { id: "t-re", from: "reviewer", to: "__end__", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
    ],
    gateways: [
      { id: "gw-split", type: "parallel", name: "并行扇出" },
      { id: "gw", type: "exclusive", name: "验收网关" },
    ],
    defaultRoutingMode: "strict",
    maxHops: 30,
    maxReworkRounds: 3,
    maxRunMinutes: 5,
    contextScope: "structured",
    recentCount: 20,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(task) {
  return {
    id: "run-1",
    teamId: "sess-gwrace",
    status: "pending",
    task,
    stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test("exclusive 网关：并行分支聚合输入——后完成的无关分支不覆盖关键词命中", async (t) => {
  useTempDataDir(t);
  const script = {
    "leader#1": { output: "任务拆解：两个模块并行开发" },
    "dev-a#1": { output: "模块A完成，验证结论：验收通过" },
    "dev-b#1": { output: "模块B完成，备注：仅记录日志", delayMs: 40 }, // 最后完成、无关键词
    "tester#1": { output: "交叉验证完成：两模块均达标" },
  };
  const exec = createDelayedExecutor(script);
  const evtLog = [];
  const rm = new RunManager({ team: makeTeam(), runId: "run-1", executor: exec, onEvent: (e) => evtLog.push(e) });
  const final = await rm.execute(makeRun("并行分支 + exclusive 网关"));

  assert.equal(final.status, "completed", `reason=${JSON.stringify(final.statusReason)} ids=${JSON.stringify(exec.calls.map((c) => c.agentId))}\nevents=${evtLog.map((e) => JSON.stringify(e)).join("\n")}`);
  const ids = exec.calls.map((c) => c.agentId);
  assert.ok(ids.includes("dev-a") && ids.includes("dev-b"), `两分支都应执行：${ids}`);
  assert.ok(ids.includes("tester"), `关键词命中的 tester 应被执行：${ids}`);
  assert.ok(!ids.includes("reviewer"), `不应落入 always 兜底分支（reviewer）：${ids}——旧实现的共享 lastOutput 会在此翻车`);
});

test("exclusive 网关：多分支场景下按优先级路由（聚合语义不破坏单边命中）", async (t) => {
  useTempDataDir(t);
  const script = {
    "leader#1": { output: "任务拆解：两个模块并行开发" },
    "dev-a#1": { output: "模块A完成 验收通过" },
    "dev-b#1": { output: "模块B通过 自测通过", delayMs: 40 },
    "tester#1": { output: "交叉验证完成：两模块均达标" },
  };
  const exec = createDelayedExecutor(script);
  const rm = new RunManager({ team: makeTeam(), runId: "run-2", executor: exec });
  const final = await rm.execute(makeRun("并行分支均含关键词"));
  assert.equal(final.status, "completed", `reason=${JSON.stringify(final.statusReason)} ids=${JSON.stringify(exec.calls.map((c) => c.agentId))}`);
  const ids = exec.calls.map((c) => c.agentId);
  assert.ok(ids.includes("tester"), `priority 10 的 tester 边应命中：${ids}`);
});
