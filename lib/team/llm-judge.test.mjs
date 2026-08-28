/**
 * P1-4：LLM judge 结构化落地 —— 单元测试。
 * 覆盖：parseJudgeChoice 全形态、describeCondition、buildJudgeUserMessage、
 * createLlmJudge（注入 mock backend）的选择/降级/禁用路径。
 * 不触网：所有用例注入 backend 或纯函数，绝不调用 createDefaultBackend。
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  parseJudgeChoice,
  describeCondition,
  buildJudgeUserMessage,
  createLlmJudge,
  JUDGE_SYSTEM_PROMPT,
} = await import("./llm-judge.ts");
const { matchingTransitions } = await import("./engine.ts");

/** 构造最小 Transition（纯 JS 测试，不做类型检查） */
function tr(id, to, cond, extra = {}) {
  return { id, from: "tester", to, priority: 0, trigger: { event: "completed", ...(cond ? { condition: cond } : {}) }, ...extra };
}

// ---------- parseJudgeChoice ----------
test("parseJudgeChoice: JSON 形态（number/string/带前后缀）", () => {
  assert.equal(parseJudgeChoice('{"choice": 2}', 3), 2);
  assert.equal(parseJudgeChoice('{"choice": "3"}', 3), 3);
  assert.equal(parseJudgeChoice('好的 {"choice":1} 完毕', 3), 1);
  assert.equal(parseJudgeChoice('{"choice": 0}', 3), 0); // 0 = 都不命中（合法）
});

test("parseJudgeChoice: 越界/非法 JSON/垃圾输出 → null 或裸数字兜底", () => {
  assert.equal(parseJudgeChoice('{"choice": 9}', 3), null); // 越界不猜
  assert.equal(parseJudgeChoice('{"choice": -1}', 3), null);
  assert.equal(parseJudgeChoice('{"choice": "abc"}', 3), null);
  assert.equal(parseJudgeChoice('{"choice":2', 3), 2); // 破损 JSON → 裸数字兜底
  assert.equal(parseJudgeChoice("我选 2", 3), 2); // 裸数字
  assert.equal(parseJudgeChoice("都不会命中", 3), null);
  assert.equal(parseJudgeChoice("", 3), null);
  // 不命中意图的常见变体
  assert.equal(parseJudgeChoice('{"choice": 0}', 0), 0);
});

test("parseJudgeChoice: 不把长数字/无关联数字误判", () => {
  assert.equal(parseJudgeChoice("错误码 409 出现", 3), null); // 409 越界
  assert.equal(parseJudgeChoice("abc123def", 3), null); // 词内数字不算
});

// ---------- describeCondition ----------
test("describeCondition: always/keyword/llm 文案", () => {
  assert.equal(describeCondition(undefined), "无条件命中");
  assert.equal(describeCondition({ mode: "always" }), "无条件命中");
  assert.equal(
    describeCondition({ mode: "keyword", keywords: ["页面", "样式"], rejectKeywords: ["接口"] }),
    "输出包含「页面、样式」任一关键词，但包含「接口」任一关键词则不命中",
  );
  assert.equal(describeCondition({ mode: "llm", conditionText: "输出表明问题出在数据库层" }), "输出表明问题出在数据库层");
  assert.equal(describeCondition({ mode: "llm" }), "由你判断该条件是否命中");
});

// ---------- buildJudgeUserMessage ----------
test("buildJudgeUserMessage: 编号候选边 + 输出节选 + 指令", () => {
  const msg = buildJudgeUserMessage([
    { transition: tr("t1", "fe-developer", { mode: "llm", conditionText: "前端 UI 问题" }), agentOutput: "按钮错位" },
    { transition: tr("t2", "be-developer", { mode: "llm", conditionText: "接口/数据层问题" }), agentOutput: "按钮错位" },
  ]);
  assert.ok(msg.includes("1. → fe-developer｜条件：前端 UI 问题"));
  assert.ok(msg.includes("2. → be-developer｜条件：接口/数据层问题"));
  assert.ok(msg.includes("按钮错位"));
  assert.ok(msg.includes('{"choice": 编号}'));
});

test("buildJudgeUserMessage: describeTarget 注入目标角色释义", () => {
  const msg = buildJudgeUserMessage(
    [{ transition: tr("t1", "fe-dev"), agentOutput: "x" }],
    4000,
    (to) => (to === "fe-dev" ? "前端开发：负责页面" : ""),
  );
  assert.ok(msg.includes("→ fe-dev（前端开发：负责页面）"));
});

test("buildJudgeUserMessage: 超长输出截断且头尾保留", () => {
  const long = "A".repeat(5000) + "TAIL_MARKER" + "B".repeat(100);
  const msg = buildJudgeUserMessage([{ transition: tr("t1", "x"), agentOutput: long }], 1000);
  assert.ok(msg.includes("……[中间省略]……"));
  assert.ok(msg.includes("TAIL_MARKER"));
  assert.ok(msg.length < 2500);
});

// ---------- createLlmJudge ----------
const CANDS = (output = "角色输出") => {
  const transitions = [tr("t1", "fe-developer", { mode: "llm" }), tr("t2", "be-developer", { mode: "llm" })];
  return transitions.map((transition) => ({ transition, agentOutput: output }));
};

test("createLlmJudge: disabled 显式与 env 均返回 undefined", async () => {
  assert.equal(createLlmJudge({ disabled: true }), undefined);
  process.env.PI_TEAM_LLM_JUDGE = "0";
  try {
    assert.equal(createLlmJudge({}), undefined);
  } finally {
    delete process.env.PI_TEAM_LLM_JUDGE;
  }
});

test("createLlmJudge: choice 命中 → 返回对应 transition", async () => {
  const judge = createLlmJudge({
    backend: { ask: async () => '{"choice": 2}' },
  });
  const picked = await judge(CANDS());
  assert.ok(picked);
  assert.equal(picked.id, "t2");
});

test("createLlmJudge: 0/垃圾/后端抛错/超时 → null（安全降级，不 throw）", async () => {
  const zero = createLlmJudge({ backend: { ask: async () => '{"choice": 0}' } });
  assert.equal(await zero(CANDS()), null);

  const garbage = createLlmJudge({ backend: { ask: async () => "我不知道" } });
  assert.equal(await garbage(CANDS()), null);

  const throwing = createLlmJudge({
    backend: { ask: async () => { throw new Error("provider down"); } },
  });
  assert.equal(await throwing(CANDS()), null);

  const never = createLlmJudge({ backend: { ask: async () => new Promise(() => undefined) }, timeoutMs: 40 });
  assert.equal(await never(CANDS()), null); // 超时降级
});

test("createLlmJudge: 空候选集不调用后端", async () => {
  let called = 0;
  const judge = createLlmJudge({ backend: { ask: async () => { called++; return '{"choice":1}'; } } });
  assert.equal(await judge([]), null);
  assert.equal(called, 0);
});

test("createLlmJudge: 创建 judge 本身不触发任何后端调用（懒初始化）", async () => {
  let asked = 0;
  const judge = createLlmJudge({
    backend: { ask: async () => { asked++; return '{"choice":1}'; } },
  });
  assert.equal(asked, 0); // 创建时不触发
  assert.equal(await judge([]), null); // 空候选集也不触发
  assert.equal(asked, 0);
});

test("createLlmJudge: 判定提示词为结构化指令（含系统提示词）", async () => {
  let seen;
  const judge = createLlmJudge({
    backend: { ask: async (input) => { seen = input; return '{"choice":1}'; } },
  });
  await judge(CANDS());
  assert.ok(seen);
  assert.equal(seen.system, JUDGE_SYSTEM_PROMPT);
  assert.ok(seen.user.includes("1. → fe-developer"));
});

// ---------- 与 engine 的集成：llm 条件经真实 judge 命中 ----------
test("engine: 注入 createLlmJudge 产物后 llm 条件可作为最后决策器命中", async () => {
  const { WorkflowEngine } = await import("./engine.ts");
  const team = {
    agents: [{ id: "tester" }, { id: "fe-developer" }, { id: "be-developer" }],
    defaultRoutingMode: "strict",
    transitions: [
      tr("e1", "fe-developer", { mode: "llm", conditionText: "前端 UI 问题" }),
      tr("e2", "be-developer", { mode: "llm", conditionText: "接口/数据层问题" }),
    ],
  };
  const engine = new WorkflowEngine(team, createLlmJudge({ backend: { ask: async () => '{"choice": 2}' } }));
  const route = await engine.resolveRoute(
    { agentId: "tester", status: "completed" },
    { status: "completed", output: "测试发现问题" },
  );
  assert.ok(route);
  assert.equal(route.to, "be-developer");
  assert.equal(route.reason, "llm");
});

test("engine: 无 judge 时 llm 条件永不命中（回归旧行为）", async () => {
  const { WorkflowEngine } = await import("./engine.ts");
  const team = {
    agents: [{ id: "tester" }, { id: "fe-developer" }],
    defaultRoutingMode: "strict",
    transitions: [tr("e1", "fe-developer", { mode: "llm", conditionText: "x" })],
  };
  const engine = new WorkflowEngine(team);
  const route = await engine.resolveRoute({ agentId: "tester", status: "completed" }, { status: "completed", output: "x" });
  assert.equal(route, null);
});

test("matchingTransitions 与 judge 候选集一致性：priority DESC", () => {
  const team = {
    transitions: [
      tr("low", "a", { mode: "llm" }, { priority: 1 }),
      tr("high", "b", { mode: "llm" }, { priority: 5 }),
    ],
  };
  const cands = matchingTransitions(team, "tester", "completed");
  assert.deepEqual(cands.map((t) => t.id), ["high", "low"]);
});
