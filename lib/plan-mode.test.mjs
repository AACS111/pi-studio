import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlanExecutionMessage,
  buildPlanStepMessage,
  cleanStageText,
  derivePlanStages,
  extractDoneSteps,
  extractPlanStages,
  extractUpdatePlanStages,
  markStagesDone,
} from "./plan-mode.ts";

const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], model: "m", provider: "p" });

test("extractPlanStages parses a 计划: numbered list", () => {
  const text = [
    "看完了相关代码，结论如下。",
    "",
    "计划：",
    "1. 第一阶段：梳理 rpc-manager 的命令分发结构",
    "2. 新增 set_plan_mode 命令并补测试",
    "3. **更新 i18n 文案**",
    "",
    "以上就是我的计划。",
  ].join("\n");
  assert.deepEqual(extractPlanStages(text), [
    { step: 1, text: "第一阶段：梳理 rpc-manager 的命令分发结构", done: false },
    { step: 2, text: "新增 set_plan_mode 命令并补测试", done: false },
    { step: 3, text: "更新 i18n 文案", done: false },
  ]);
});

test("extractPlanStages supports English Plan: and 1) / 1、 styles", () => {
  const text = "Plan:\n1) Do the thing\n2、Then verify";
  assert.deepEqual(extractPlanStages(text), [
    { step: 1, text: "Do the thing", done: false },
    { step: 2, text: "Then verify", done: false },
  ]);
});

test("extractPlanStages ignores numbered lists without a plan header", () => {
  assert.deepEqual(extractPlanStages("Steps:\n1. alpha\n2. beta"), []);
  assert.deepEqual(extractPlanStages(""), []);
});

test("extractPlanStages dedupes repeated step numbers", () => {
  const text = "计划：\n1. one\n1. one again\n2. two";
  assert.deepEqual(extractPlanStages(text).map((s) => s.step), [1, 2]);
});

test("cleanStageText strips markdown and done markers", () => {
  assert.equal(cleanStageText("**Use** `read` to inspect [DONE:2]"), "Use read to inspect");
  assert.equal(cleanStageText("trailing markers**"), "trailing markers");
});

test("extractDoneSteps finds all markers case-insensitively", () => {
  assert.deepEqual(extractDoneSteps("done [DONE:1] and [done:3]"), [1, 3]);
  assert.deepEqual(extractDoneSteps("none"), []);
});

test("markStagesDone is immutable and only flips matching steps", () => {
  const stages = [
    { step: 1, text: "a", done: false },
    { step: 2, text: "b", done: false },
  ];
  const next = markStagesDone(stages, [2, 9]);
  assert.equal(next[0].done, false);
  assert.equal(next[1].done, true);
  assert.equal(stages[1].done, false, "original array untouched");
});

test("derivePlanStages anchors on the latest plan and accumulates later DONE markers", () => {
  const messages = [
    { role: "user", content: "plan it" },
    assistant("计划：\n1. one\n2. two\n3. three"),
    assistant("正在做第一步"),
    assistant("完成两步 [DONE:1] [DONE:2]"),
  ];
  assert.deepEqual(derivePlanStages(messages).map((s) => s.done), [true, true, false]);
});

test("derivePlanStages ignores DONE markers before the plan anchor", () => {
  const messages = [
    assistant("old plan [DONE:1]"),
    { role: "user", content: "again" },
    assistant("计划：\n1. fresh\n2. second"),
  ];
  assert.deepEqual(derivePlanStages(messages).map((s) => s.done), [false, false]);
});

test("derivePlanStages returns [] when no plan exists", () => {
  assert.deepEqual(derivePlanStages([{ role: "user", content: "hi" }, assistant("hello")]), []);
});

test("buildPlanExecutionMessage keeps original step numbers", () => {
  const msg = buildPlanExecutionMessage([
    { step: 1, text: "first", done: false },
    { step: 3, text: "third", done: false },
  ]);
  assert.match(msg, /1\. first/);
  assert.match(msg, /3\. third/);
  // 批量执行指令引导模型用 update_plan 实时更新进度
  assert.match(msg, /update_plan/);
});

test("buildPlanStepMessage runs exactly one stage and asks to stop", () => {
  const msg = buildPlanStepMessage({ step: 2, text: "add tests", done: false });
  assert.match(msg, /第 2 阶段/);
  assert.match(msg, /add tests/);
  assert.match(msg, /立即停止/);
  assert.match(msg, /\[DONE:2\]/);
  // 单步指令不是「开始执行计划」总清单，不能触发新的批量执行语义
  assert.doesNotMatch(msg, /\[开始执行计划\]/);
});

test("extractUpdatePlanStages maps update_plan details to stages", () => {
  const stages = extractUpdatePlanStages({
    plan: [
      { step: "one", status: "completed" },
      { step: "two", status: "in_progress" },
      { step: "three", status: "pending" },
    ],
  });
  assert.deepEqual(stages, [
    { step: 1, text: "one", done: true, status: "completed" },
    { step: 2, text: "two", done: false, status: "in_progress" },
    { step: 3, text: "three", done: false, status: "pending" },
  ]);
});

test("extractUpdatePlanStages returns [] for malformed details", () => {
  assert.deepEqual(extractUpdatePlanStages(undefined), []);
  assert.deepEqual(extractUpdatePlanStages({}), []);
  assert.deepEqual(extractUpdatePlanStages({ plan: [] }), []);
});

test("derivePlanStages prefers the latest update_plan result over text plans", () => {
  const messages = [
    assistant("计划：\n1. old text plan\n2. second"),
    {
      role: "toolResult",
      toolName: "update_plan",
      details: { plan: [{ step: "live 1", status: "completed" }, { step: "live 2", status: "in_progress" }] },
    },
  ];
  const stages = derivePlanStages(messages);
  assert.deepEqual(stages.map((s) => s.text), ["live 1", "live 2"]);
  assert.equal(stages[1].status, "in_progress");
  assert.equal(stages[0].done, true);
});
