/**
 * turn-nudge 单测：运行 `node --test lib/turn-nudge.test.mjs`
 *
 * 场景来自真实会话复盘（2026-09-12 23:30 会话：82 回合里 79 个纯工具回合，
 * 连续 58 轮零正文），断言三件事：什么时候该提醒、什么时候绝不能提醒、
 * 提醒本身不能被模型当成新循环的燃料。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  TURN_NUDGE_DEFAULT_STREAK,
  TURN_NUDGE_MAX_PER_RUN,
  TurnNudgeTracker,
  isToolOnlyAssistantContent,
  readTurnNudgeThreshold,
  turnNudgeInstruction,
} from "./turn-nudge.ts";

const toolOnly = (thinking = "继续调试") => [
  { type: "thinking", thinking },
  { type: "toolCall", id: "c1", name: "bash", arguments: { command: "node probe.mjs" } },
];
const withText = (text) => [
  { type: "thinking", thinking: "想一下" },
  { type: "text", text },
  { type: "toolCall", id: "c2", name: "edit", arguments: {} },
];

test("只有思考和工具调用 → 判定为纯工具回合", () => {
  assert.equal(isToolOnlyAssistantContent(toolOnly()), true);
  // 多个工具调用、没有 text 也算
  assert.equal(
    isToolOnlyAssistantContent([
      { type: "thinking", thinking: "x" },
      { type: "toolCall", id: "a", name: "read", arguments: {} },
      { type: "toolCall", id: "b", name: "read", arguments: {} },
    ]),
    true,
  );
});

test("全空白 text 块仍算纯工具回合（模型偶尔吐空 text）", () => {
  assert.equal(
    isToolOnlyAssistantContent([{ type: "text", text: "\n  " }, { type: "toolCall", id: "a", name: "bash", arguments: {} }]),
    true,
  );
});

test("只要有一句非空正文就算正常回合 —— 边做边汇报不该被打扰", () => {
  assert.equal(isToolOnlyAssistantContent(withText("Now the CSS edits:")), false);
  assert.equal(
    isToolOnlyAssistantContent([
      { type: "toolCall", id: "a", name: "bash", arguments: {} },
      { type: "text", text: "改完了，接下来验证。" },
    ]),
    false,
  );
});

test("没有工具调用的回合不算（纯文本回答 / 空回合）", () => {
  assert.equal(isToolOnlyAssistantContent([{ type: "text", text: "结论如下" }]), false);
  assert.equal(isToolOnlyAssistantContent([{ type: "thinking", thinking: "只想了下" }]), false);
  assert.equal(isToolOnlyAssistantContent([]), false);
  assert.equal(isToolOnlyAssistantContent(undefined), false);
  assert.equal(isToolOnlyAssistantContent("字符串不是内容数组"), false);
});

test("连续达到阈值才提醒，且只提醒一次（不是每轮都催）", () => {
  const t = new TurnNudgeTracker(3, 5);
  assert.equal(t.observe(toolOnly()), false); // streak 1
  assert.equal(t.observe(toolOnly()), false); // streak 2
  assert.equal(t.observe(toolOnly()), true); // streak 3 → 提醒
  assert.equal(t.currentStreak, 0); // 触发后清零，重新攒
  assert.equal(t.observe(toolOnly()), false);
  assert.equal(t.observe(toolOnly()), false);
  assert.equal(t.observe(toolOnly()), true);
});

test("中途出现正文会清零计数（正常轮次打断循环）", () => {
  const t = new TurnNudgeTracker(3, 5);
  t.observe(toolOnly());
  t.observe(toolOnly());
  assert.equal(t.observe(withText("先说一下思路：")), false);
  assert.equal(t.currentStreak, 0);
  // 重新攒够 3 轮才会提醒
  t.observe(toolOnly());
  t.observe(toolOnly());
  assert.equal(t.observe(toolOnly()), true);
});

test("单次任务最多提醒 TURN_NUDGE_MAX_PER_RUN 次，防止提醒变成新的循环", () => {
  const t = new TurnNudgeTracker(1, 3);
  assert.equal(t.observe(toolOnly()), true);
  assert.equal(t.observe(toolOnly()), true);
  assert.equal(t.observe(toolOnly()), true);
  for (let i = 0; i < 20; i++) {
    assert.equal(t.observe(toolOnly()), false, `第 ${i + 4} 次不应该再提醒`);
  }
});

test("reset 后重新计数（每个新 prompt 都是新的预算）", () => {
  const t = new TurnNudgeTracker(2, 1);
  t.observe(toolOnly());
  assert.equal(t.observe(toolOnly()), true);
  assert.equal(t.observe(toolOnly()), false); // 预算用完
  t.reset();
  assert.equal(t.observe(toolOnly()), false);
  assert.equal(t.observe(toolOnly()), true);
});

test("阈值 0 表示关闭：任何情况都不提醒", () => {
  const t = new TurnNudgeTracker(0, 5);
  for (let i = 0; i < 50; i++) assert.equal(t.observe(toolOnly()), false);
});

test("阈值默认 8、单次预算默认 3", () => {
  const t = new TurnNudgeTracker();
  for (let i = 0; i < TURN_NUDGE_DEFAULT_STREAK - 1; i++) {
    assert.equal(t.observe(toolOnly()), false);
  }
  assert.equal(t.observe(toolOnly()), true);
  assert.equal(TURN_NUDGE_MAX_PER_RUN, 3);
});

test("环境变量：缺省用默认值，0 关闭，正整数改阈值，脏值回落默认", () => {
  assert.equal(readTurnNudgeThreshold({}), TURN_NUDGE_DEFAULT_STREAK);
  assert.equal(readTurnNudgeThreshold({ PI_TURN_NUDGE_TOOL_ONLY: "" }), TURN_NUDGE_DEFAULT_STREAK);
  assert.equal(readTurnNudgeThreshold({ PI_TURN_NUDGE_TOOL_ONLY: "0" }), 0);
  assert.equal(readTurnNudgeThreshold({ PI_TURN_NUDGE_TOOL_ONLY: "3" }), 3);
  assert.equal(readTurnNudgeThreshold({ PI_TURN_NUDGE_TOOL_ONLY: "-2" }), TURN_NUDGE_DEFAULT_STREAK);
  assert.equal(readTurnNudgeThreshold({ PI_TURN_NUDGE_TOOL_ONLY: "abc" }), TURN_NUDGE_DEFAULT_STREAK);
});

test("提醒文本必须点明「用户看不到工具输出」并要求停止调用工具", () => {
  // 这几句是机制有效的前提，删掉就等于只多了一条空转消息
  const instruction = turnNudgeInstruction(8);
  assert.match(instruction, /看不到/);
  assert.match(instruction, /停止调用工具/);
  assert.match(instruction, /验证结果/);
  assert.match(instruction, /连续 8 个回合/);
  // ★ 实测教训：模型会把这条提醒原话转述给用户（“按宿主提醒本轮我先停手”），
  //   必须显式禁止它提及提醒本身
  assert.match(instruction, /不要向用户提及它本身/);
});

test("提醒里带闸门 ②：要求给出验证结果而不只是“已完成”", () => {
  const instruction = turnNudgeInstruction(3);
  assert.match(instruction, /跑了什么/);
  assert.match(instruction, /需要用户确认/);
  assert.match(instruction, /不要复述完整命令输出/);
});
