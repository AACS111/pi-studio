import assert from "node:assert/strict";
import test from "node:test";
import { ASK_USER_TOOL_NAME, createPlanTools } from "./plan-tool.ts";
import { UPDATE_PLAN_TOOL_NAME } from "./plan-mode.ts";

function toolsFor(responses = []) {
  const calls = [];
  const bridge = {
    ask: async (request) => {
      calls.push(request);
      return responses.shift();
    },
  };
  const tools = createPlanTools(bridge);
  return {
    calls,
    askUser: tools.find((tool) => tool.name === ASK_USER_TOOL_NAME),
    updatePlan: tools.find((tool) => tool.name === UPDATE_PLAN_TOOL_NAME),
  };
}

function makeTool(responses) {
  const { calls, askUser } = toolsFor(responses);
  return { tool: askUser, calls };
}

test("registers both plan tools with stable names", () => {
  const { askUser, updatePlan } = toolsFor();
  assert.equal(askUser.name, "ask_user");
  assert.equal(updatePlan.name, "update_plan");
  assert.equal(updatePlan.executionMode, "sequential");
});

test("ask_user returns the option the user picked", async () => {
  const { tool, calls } = makeTool(["方案 B"]);
  const res = await tool.execute("id", { question: "用哪种实现？", options: ["方案 A", "方案 B"] }, undefined, undefined, undefined);
  assert.equal(res.details.answer, "方案 B");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "select");
  assert.equal(calls[0].title, "用哪种实现？");
  assert.deepEqual(calls[0].options, ["方案 A", "方案 B", "其他（自己填写）"]);
});

test("ask_user lets the user type a custom plan", async () => {
  const { tool, calls } = makeTool(["其他（自己填写）", "  我的方案  "]);
  const res = await tool.execute("id", { question: "q", options: ["A", "B"] }, undefined, undefined, undefined);
  assert.equal(res.details.answer, "我的方案");
  assert.equal(calls[1].method, "input");
});

test("ask_user honours a custom customLabel", async () => {
  const { tool, calls } = makeTool(["Other", "typed by user"]);
  const res = await tool.execute("id", { question: "q", options: ["A", "B"], customLabel: "Other" }, undefined, undefined, undefined);
  assert.deepEqual(calls[0].options, ["A", "B", "Other"]);
  assert.equal(calls[1].method, "input");
  assert.equal(res.details.answer, "typed by user");
});

test("ask_user custom input cancelled marks cancelled and tells the model to be conservative", async () => {
  const { tool } = makeTool(["其他（自己填写）", undefined]);
  const res = await tool.execute("id", { question: "q", options: ["A", "B"] }, undefined, undefined, undefined);
  assert.equal(res.details.cancelled, true);
  assert.equal(res.details.answer, null);
  assert.match(res.content[0].text, /最保守/);
});

test("ask_user select cancelled marks cancelled", async () => {
  const { tool } = makeTool([undefined]);
  const res = await tool.execute("id", { question: "q", options: ["A", "B"] }, undefined, undefined, undefined);
  assert.equal(res.details.cancelled, true);
  assert.equal(res.details.answer, null);
});

test("ask_user rejects fewer than two options without calling the UI", async () => {
  const { tool, calls } = makeTool([]);
  const res = await tool.execute("id", { question: "q", options: ["only"] }, undefined, undefined, undefined);
  assert.equal(calls.length, 0);
  assert.match(res.content[0].text, /至少需要 2 个选项/);
});

test("ask_user degrades gracefully when no UI bridge is available", async () => {
  const tool = createPlanTools({}).find((t) => t.name === ASK_USER_TOOL_NAME);
  const res = await tool.execute("id", { question: "q", options: ["A", "B"] }, undefined, undefined, undefined);
  assert.equal(res.details.answer, null);
  assert.match(res.content[0].text, /不支持交互式询问/);
});

test("update_plan stores the full plan in details and summarizes progress", async () => {
  const { updatePlan } = toolsFor();
  const res = await updatePlan.execute(
    "id",
    {
      plan: [
        { step: "梳理代码", status: "completed" },
        { step: "  加单测  ", status: "in_progress" },
        { step: "更新文档", status: "pending" },
      ],
    },
    undefined,
    undefined,
    undefined,
  );
  assert.deepEqual(res.details.plan, [
    { step: "梳理代码", status: "completed" },
    { step: "加单测", status: "in_progress" },
    { step: "更新文档", status: "pending" },
  ]);
  assert.match(res.content[0].text, /1\/3 完成/);
  assert.match(res.content[0].text, /进行中/);
});

test("update_plan keeps explanation when the plan changed", async () => {
  const { updatePlan } = toolsFor();
  const res = await updatePlan.execute(
    "id",
    { explanation: "发现新依赖", plan: [{ step: "先装依赖", status: "pending" }] },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(res.details.explanation, "发现新依赖");
});

test("update_plan rejects an empty plan", async () => {
  const { updatePlan } = toolsFor();
  const res = await updatePlan.execute("id", { plan: [{ step: "   ", status: "pending" }] }, undefined, undefined, undefined);
  assert.deepEqual(res.details.plan, []);
  assert.match(res.content[0].text, /不能为空/);
});
