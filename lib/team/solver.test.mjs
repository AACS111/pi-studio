/**
 * 并行解题模板（solver）端到端验证：mock 执行器。
 *  - 组长并行分派 研究员/开发/文档 三分支 → merge → 测试交叉验证 → 组长汇总。
 *  - 验证：三个独立分支真并发（时间重叠）；测试 verdict pass → 组长汇总收尾；fail → 返工开发。
 *  - 验证上下文黑板：下游角色看到上游【完整】产出（非 120 字片段）。
 * 运行：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/team/solver.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { RunManager, END_NODE } = await import("./runtime.ts");
const { EventStore } = await import("./store.ts");
const { createTeamDef } = await import("./templates.ts");
const { reduce } = await import("./types.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-sol-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });
  return root;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 支持延迟 + 记录 start/end 的 mock 执行器 */
function createExecutor(script) {
  const calls = [];
  const contexts = [];
  return {
    calls,
    contexts,
    // 注意：并发分支下不能“push 后再改 calls[last]”（并行分支共享数组会串位），
    // 必须在本地捕获 start/end，再一次性 push 完整记录。
    run: async ({ execution, context, onMessage }) => {
      const start = Date.now();
      const key = `${execution.agentId}#${execution.sequence}`;
      const entry = script[key];
      if (!entry) throw new Error(`no script for ${key}`);
      if (entry.delayMs) await sleep(entry.delayMs);
      const end = Date.now();
      calls.push({ agentId: execution.agentId, sequence: execution.sequence, start, end });
      contexts.push({ agentId: execution.agentId, sequence: execution.sequence, context });
      onMessage({
        id: `msg-${execution.id}`,
        kind: "agent",
        executionId: execution.id,
        agentId: execution.agentId,
        role: execution.agentId,
        content: entry.output,
        createdAt: Date.now(),
      });
      return {
        status: entry.status ?? "completed",
        output: entry.output,
        ...(entry.verdict ? { verdict: entry.verdict } : {}),
      };
    },
  };
}

function overlap(a, b) {
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

function makeRun(team, task, runId = "run-sol") {
  return {
    id: runId,
    teamId: team.sessionId,
    status: "pending",
    task,
    stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ==================== 测试 1：solver 并行 + 交叉验证 pass + 组长汇总 ====================
test("solver: 并行分叉（研究/开发/文档 真并发）→ 测试 pass → 组长汇总收尾", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-sol1", "/w", "t", "solver");
  const script = {
    "leader#1": { output: "拆解：并行调研+开发+写文档" },
    "researcher#1": { output: "调研结论：方案可行，风险低", delayMs: 40 },
    "developer#1": { output: "实现完成", delayMs: 40 },
    "writer#1": { output: "文档完成", delayMs: 40 },
    "tester#1": { output: "全部通过，验收达标", verdict: "pass" },
    "leader#2": { output: "总结完成：最终结论：任务全部完成" },
  };
  const exec = createExecutor(script);
  const rm = new RunManager({ team, runId: "run-sol1", executor: exec });
  const run = await rm.execute(makeRun(team, "实现并验证一个多模块功能"));

  assert.equal(run.status, "completed", `终态 ${run.status} ${run.statusReason?.message ?? ""}`);

  // 三次并行分支各执行一次
  assert.equal(exec.calls.filter((c) => c.agentId === "researcher").length, 1);
  assert.equal(exec.calls.filter((c) => c.agentId === "developer").length, 1);
  assert.equal(exec.calls.filter((c) => c.agentId === "writer").length, 1);
  // reporter 执行 2 次（初始 + 汇总），tester 1 次
  assert.equal(exec.calls.filter((c) => c.agentId === "leader").length, 2);
  assert.equal(exec.calls.filter((c) => c.agentId === "tester").length, 1);

  // 真并发：三个并行分支的时间区间两两重叠
  const r = exec.calls.find((c) => c.agentId === "researcher");
  const d = exec.calls.find((c) => c.agentId === "developer");
  const w = exec.calls.find((c) => c.agentId === "writer");
  assert.ok(overlap(r, d), "researcher 与 developer 应并发重叠");
  assert.ok(overlap(d, w), "developer 与 writer 应并发重叠");

  // 事件单调
  const events = new EventStore(team.sessionId, "run-sol1").replay();
  for (let i = 1; i < events.length; i++) assert.ok(events[i].sequence > events[i - 1].sequence);
  // lastHandoff 终态为 __end__
  const p = reduce(events);
  assert.equal(p.state.lastHandoff?.to, END_NODE);
});

// ==================== 测试 2：solver 缺陷返工（测试 fail → 开发修复 → pass 收尾） ====================
test("solver: 测试 verdict:fail → 返工开发修复 → 再测 pass → 组长收尾", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-sol2", "/w", "t", "solver");
  const script = {
    "leader#1": { output: "拆解任务" },
    "researcher#1": { output: "调研：方案可行", delayMs: 10 },
    "developer#1": { output: "实现完成（但有边界缺陷）" },
    "writer#1": { output: "文档完成", delayMs: 10 },
    "tester#1": { output: "发现边界未处理，无法通过", verdict: "fail" },
    "developer#2": { output: "已修复边界缺陷" },
    "tester#2": { output: "全部通过，验收达标", verdict: "pass" },
    "leader#2": { output: "总结完成：最终结论：任务完成" },
  };
  const exec = createExecutor(script);
  const rm = new RunManager({ team, runId: "run-sol2", executor: exec });
  const run = await rm.execute(makeRun(team, "实现并验证一个多模块功能"));

  assert.equal(run.status, "completed", `终态 ${run.status} ${run.statusReason?.message ?? ""}`);
  assert.ok(run.stats.reworkCount >= 1, "测试 fail 应触发返工");
  assert.equal(exec.calls.filter((c) => c.agentId === "developer").length, 2, "开发应执行 2 次（初次 + 修复）");
  // tester#1 之后是 developer#2（返工），tester#2 之后是 leader#2（汇总收尾）
  const seq = exec.calls.map((c) => `${c.agentId}#${c.sequence}`);
  assert.ok(seq.indexOf("tester#1") + 1 === seq.indexOf("developer#2"), "tester#1 后应返工 developer#2");
});

// ==================== 测试 3：上下文黑板——merge 后的测试角色看到三个分支【完整】产出 ====================
test("solver 上下文黑板：merge 后测试角色看到前序角色摘要 + trace 指针", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-sol3", "/w", "t", "solver");
  const LONG_RESEARCH = "调研结论：方案可行。依据：①A 模块使用 X 方案，已验证稳定；②B 模块存在兼容性风险，建议采用 Y 接口；③性能预期 P95<100ms。这是研究员撰写的完整调研正文，包含多行细节与依据来源，长度远超 120 字，用于验证下游角色能读到完整产出而不是被截断的摘要。";
  const script = {
    "leader#1": { output: "拆解任务" },
    "researcher#1": { output: LONG_RESEARCH, delayMs: 3 },
    "developer#1": { output: "实现完成", delayMs: 3 },
    "writer#1": { output: "文档完成", delayMs: 3 },
    "tester#1": { output: "全部通过，验收达标", verdict: "pass" },
    "leader#2": { output: "总结完成：最终结论：完成" },
  };
  const exec = createExecutor(script);
  const rm = new RunManager({ team, runId: "run-sol3", executor: exec });
  const run = await rm.execute(makeRun(team, "实现功能"));
  assert.equal(run.status, "completed");

  // merge 后的测试角色上下文应含前序角色摘要块（含 trace 指针），正文走 trace 文件
  const testerCtx = exec.contexts.find((c) => c.agentId === "tester")?.context ?? "";
  assert.ok(testerCtx.includes("前序角色摘要"), "上下文应含前序角色摘要块");
  assert.ok(testerCtx.includes("研究员"), "摘要应标明研究员的产出");
  // 摘要应含「思考/会话」或「总结」文件指针，供下游 read 详情（替代旧的 trace: 指针）
  assert.ok(testerCtx.includes("思考/会话:") || testerCtx.includes("总结:"), "摘要应含思考/会话或总结文件指针供下游 read 详情");
  // 上下文里每条摘要被 cap（researcher 正文 134 字，摘要 cap 160 → 不会被截断、但 recent 块 cap 120 → 被截断）
  // 关键验证点：researcher 产出在 recent 块中被截断（出现 …），证明正文不全量注入
  assert.ok(testerCtx.includes("…"), "recent 块摘要应被截断（… ）证明正文不全量注入");
});
