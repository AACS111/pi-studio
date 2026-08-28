/**
 * bcfc16cd 复盘修复包回归测试：
 *  ① 写权限策略（resolveWritePolicy / applyWritePolicyToToolNames / createDocWriteTool / checkDocWritePath）
 *  ② 群聊消息恒非空兜底 + 假宣称检测（buildFallbackGroupMessage / detectPhantomClaims）
 *  ③ 截断诚实化（executionStatusLine）
 *  ④ thinking.md 富化块（buildReadableExecutionBlock）
 *  ⑤ verdict 同向多边消歧（engine.resolveRoute 用交接摘要先判关键词）
 *  ⑥ 上下文指针换向 .md + 收尾要求注入（context.buildContext）
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/role-boundary.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const X = await import("./executor.ts");
const {
  resolveWritePolicy,
  applyWritePolicyToToolNames,
  detectPhantomClaims,
  buildFallbackGroupMessage,
  executionStatusLine,
  buildReadableExecutionBlock,
} = X;
const T = await import("./tools.ts");
const { checkDocWritePath } = T;
const E = await import("./engine.ts");
const C = await import("./context.ts");

test("① resolveWritePolicy：显式优先；缺省按 toolNames 是否含 edit 推导", () => {
  assert.equal(resolveWritePolicy({ writePolicy: "docs", toolNames: ["edit"] }), "docs");
  assert.equal(resolveWritePolicy({ writePolicy: undefined, toolNames: ["read", "bash", "edit", "write"] }), "all");
  assert.equal(resolveWritePolicy({ writePolicy: undefined, toolNames: ["read", "write", "grep"] }), "docs");
});

test("① docs/none 白名单剔除 edit+write；all 原样", () => {
  const names = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  assert.deepEqual(applyWritePolicyToToolNames("all", names), names);
  assert.deepEqual(applyWritePolicyToToolNames("docs", names), ["read", "bash", "grep", "find", "ls"]);
  assert.deepEqual(applyWritePolicyToToolNames("none", names), ["read", "bash", "grep", "find", "ls"]);
});

test("① 文档写工具路径校验：只许 .md 且必须在 cwd 内", () => {
  const cwd = "/work/proj";
  assert.equal(checkDocWritePath(cwd, "/work/proj/docs/方案.md").ok, true);
  assert.equal(checkDocWritePath(cwd, "notes/说明.markdown").ok, true);
  assert.match(checkDocWritePath(cwd, "src/Main.java").error, /文档写权限/);
  assert.match(checkDocWritePath(cwd, "scripts/.patch-filterbar.mjs").error, /文档写权限/);
  assert.match(checkDocWritePath(cwd, "/etc/passwd.md").error, /工作目录|越出|超出/s);
});

test("② 假宣称检测：product 式「现在重写 X.java」被抓；真实写过的文件不报", () => {
  const actual = new Set(["MPSHandler.java"]);
  const hits = detectPhantomClaims(
    "链路已清晰。现在整文件重写 `TcMslFileServiceImpl.java`（3 处改动）。\n改动文件：MPSHandler.java（共 1 个）",
    actual,
  );
  assert.ok(hits.some((h) => h.includes("TcMslFileServiceImpl.java")), JSON.stringify(hits));
  assert.ok(!hits.some((h) => h.includes("MPSHandler.java")));
  // 中性提及/验证语句不误报
  assert.deepEqual(detectPhantomClaims("已验证 TcMslFileServiceImpl.java 的逻辑，读取了 SheetIndex.vue", new Set()), []);
});

test("② 群聊消息恒非空：be-developer 式「无文本+无交接+无变更」也必须产出可见结论（修静默空转③）", () => {
  const r = buildFallbackGroupMessage({ output: "", changedFiles: [], truncated: true, turnsUsed: 26, maxTurns: 60 });
  assert.ok(r.content.trim().length > 0);
  assert.match(r.content, /上限|未产出/);
  // 有文本时拼真实变更清单；截断追加诚实警示
  const r2 = buildFallbackGroupMessage({
    output: "改完了",
    handoffSummary: "交接给 tester",
    changedFiles: [{ filePath: "/a/b/SheetFilterBar.vue", kind: "edit" }],
    truncated: true,
    turnsUsed: 60,
    maxTurns: 60,
  });
  assert.match(r2.content, /SheetFilterBar\.vue/);
  assert.match(r2.content, /提前收尾|核实/);
});

test("② 假宣称警示进入群聊内容：宣称改 vue 但实际只写了 java → 内容里出现核对提示", () => {
  const r = buildFallbackGroupMessage({
    output: "前端 `SheetFilterBar.vue` 已改造完成，交互正常。",
    changedFiles: [{ filePath: "/x/TcMslFileServiceImpl.java", kind: "edit" }],
    truncated: false,
    turnsUsed: 40,
    maxTurns: 60,
  });
  assert.match(r.content, /实际改动文件.*TcMslFileServiceImpl\.java/s);
});

test("③ 截断状态行不再硬编码「完成」", () => {
  assert.equal(executionStatusLine(false, 12, 60), "完成");
  assert.match(executionStatusLine(true, 60, 60), /截断/);
});

test("④ thinking.md 富化块：包含结论/工具轨迹/变更清单/思考节选四段", () => {
  const md = buildReadableExecutionBlock({
    sequence: 3,
    iso: "2026-08-27T00:00:00.000Z",
    output: "结论A",
    handoffTo: "tester",
    handoffSummary: "请验证",
    changedFiles: [{ filePath: "/p/Q.java", kind: "write" }],
    toolsLog: ["📖 读取 A.vue", "✍️ 写入 Q.java"],
    thinkingFull: "思考".repeat(10),
  });
  for (const part of ["### 结论", "### 交接", "### 实际变更文件", "### 工具轨迹", "### 思考流水"]) {
    assert.ok(md.includes(part), part);
  }
  // 思考超长时节选而非全量
  const big = buildReadableExecutionBlock({
    sequence: 1,
    iso: "",
    output: "",
    changedFiles: [],
    toolsLog: [],
    thinkingFull: "x".repeat(20000),
  });
  assert.ok(big.includes("省略") && big.length < 20000);
});

// —— ⑤ engine verdict 多边消歧 ——

function miniTeam(transitions) {
  return {
    sessionId: "s", name: "t", cwd: "/w", entryAgentId: "leader", executionMode: "custom",
    defaultRoutingMode: "workflow", maxHops: 30, maxReworkRounds: 3, maxRunMinutes: 60,
    contextScope: "structured", recentCount: 5, createdAt: 0, updatedAt: 0,
    agents: [
      { id: "tester", name: "测试", model: "", systemPrompt: "", toolNames: [] },
      { id: "fe-developer", name: "前端", model: "", systemPrompt: "", toolNames: [] },
      { id: "be-developer", name: "后端", model: "", systemPrompt: "", toolNames: [] },
    ],
    transitions,
    reworkEdges: [],
  };
}

test("⑤ verdict=fail 且 fe/be 双 fail 边同向：用 decisionContent 消歧——问题归属描述指前端则路由 fe，而非全文「后端」关键词误派 be", async () => {
  const wf = new E.WorkflowEngine(miniTeam([
    { id: "t-be", from: "tester", to: "be-developer", priority: 21, verdictGuard: "fail", trigger: { event: "completed", condition: { mode: "keyword", keywords: ["后端", "接口", "java"] } } },
    { id: "t-fe", from: "tester", to: "fe-developer", priority: 20, verdictGuard: "fail", trigger: { event: "completed", condition: { mode: "keyword", keywords: ["前端", "vue", "组件", "筛选框"] } } },
    { id: "t-fb", from: "tester", to: "be-developer", priority: 15, trigger: { event: "completed", condition: { mode: "always" } } },
  ]));
  // 复刻本案例误派路径：全文同时含“后端改完”与前端问题描述；
  // 但角色已用 team_record_decision 记录了问题归属（content 明确指前端）→ 应据 content 而非全文命中
  const route = await wf.resolveRoute(
    { agentId: "tester", status: "completed" },
    {
      status: "completed",
      output: "后端接口已改完。验证时发现前端问题：筛选框多选未实现，SheetFilterBar.vue 需返工。",
      verdict: "fail",
      decisionContent: "验证不通过：根因在前端 SheetFilterBar.vue 多选逻辑未实现，与后端接口无关。",
    },
    2,
  );
  assert.equal(route?.kind, "transition");
  assert.match(route.reason, /^verdict:/);
  assert.equal(route.to, "fe-developer");
});

test("⑤ 消歧都无命中时回退最高优先级边，保持确定性", async () => {
  const wf = new E.WorkflowEngine(miniTeam([
    { id: "t-be", from: "tester", to: "be-developer", priority: 21, verdictGuard: "fail", trigger: { event: "completed", condition: { mode: "keyword", keywords: ["后端"] } } },
    { id: "t-fe", from: "tester", to: "fe-developer", priority: 20, verdictGuard: "fail", trigger: { event: "completed", condition: { mode: "keyword", keywords: ["前端"] } } },
  ]));
  const route = await wf.resolveRoute(
    { agentId: "tester", status: "completed" },
    { status: "completed", output: "泛泛而谈无明显归属词", verdict: "fail", decisionContent: "部分场景超时，需进一步排查。" },
    3,
  );
  assert.equal(route?.to, "be-developer"); // p21 更高
});

test("⑤ 单条 verdictGuard 命中边直接短路，不再落入裸 always 边", async () => {
  const wf = new E.WorkflowEngine(miniTeam([
    { id: "t-fe", from: "tester", to: "fe-developer", priority: 30, verdictGuard: "fail", trigger: { event: "completed", condition: { mode: "keyword", keywords: ["前端"] } } },
    { id: "t-always", from: "tester", to: "leader", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
  ]));
  const route = await wf.resolveRoute(
    { agentId: "tester", status: "completed" },
    { status: "completed", output: "完全没提任何关键词的内容", verdict: "fail" },
    1,
  );
  assert.equal(route?.to, "fe-developer");
});

// —— ⑥ context 指针与收尾要求 ——

const CTX_TEAM = {
  sessionId: "ctx-1", name: "t", cwd: "/w", entryAgentId: "leader", executionMode: "custom",
  defaultRoutingMode: "workflow", maxHops: 30, maxReworkRounds: 3, maxRunMinutes: 60,
  contextScope: "structured", recentCount: 5, createdAt: 0, updatedAt: 0,
  agents: [
    { id: "fe-developer", name: "前端", model: "", systemPrompt: "", toolNames: [] },
    { id: "tester", name: "测试", model: "", systemPrompt: "", toolNames: [] },
  ],
  transitions: [], reworkEdges: [],
};

test("⑥ 上下文注入收尾要求块 + 前序指针指向 .md 而非 jsonl", () => {
  const ctx = C.buildContext({
    team: CTX_TEAM,
    run: { id: "r1", teamId: "ctx-1", status: "running", task: "T", complexity: "complex", stats: {}, createdAt: 0, updatedAt: 0 },
    projections: { state: { phase: "executing", tasks: [], decisions: [], artifacts: [], messages: [], activeTasks: [], completedTasks: [] }, messages: [], tasks: [] },
    agent: CTX_TEAM.agents[0],
  });
  assert.match(ctx, /## 收尾要求（每次执行结束前必须遵守）/);
  assert.match(ctx, /team_record_decision[\s\S]*verdict/);
  assert.match(ctx, /严禁声称已修改但未落盘的文件/);
});
