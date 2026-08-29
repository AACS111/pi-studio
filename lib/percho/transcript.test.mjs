/**
 * percho transcript 大脑（lib/percho）在 pi-web SDK 事件流上的端到端回归测试。
 * 覆盖 percho reducer 依赖的增量事件（turn_start/turn_end/tool_execution_update/assistantMessageEvent），
 * 这些事件正是 pi-web 旧 SSE toClientEvent 裁剪掉的 v1 路径缺失的——本测试保证 v2 全量流可正确归约。
 *
 * 跑法：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/percho/transcript.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { emptyTranscript } from "./transcript/types.ts";
import { reduceEvent } from "./transcript/reducer.ts";
import { buildChatRows } from "./transcript/chat-rows.ts";
import { messagesToUIMessages } from "./transcript/mapping.ts";

test("用户消息 + assistant 平滑流式（turn_start/turn_end/assistantMessageEvent）", async () => {
  let s = emptyTranscript();
  s = reduceEvent(s, { type: "agent_start" });
  s = reduceEvent(s, { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  s = reduceEvent(s, { type: "message_start", message: { role: "user", content: "帮我分析这个项目" } });
  assert.equal(s.messages.filter((m) => m.kind === "user").length, 1);
  assert.equal(s.messages[0].text, "帮我分析这个项目");

  s = reduceEvent(s, { type: "message_start", message: { role: "assistant", content: [] } });
  s = reduceEvent(s, {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "让我想想" },
  });
  s = reduceEvent(s, {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "好的，" },
  });
  assert.equal(s.streaming?.thinking, "让我想想");
  assert.equal(s.streaming?.text, "好的，");
  s = reduceEvent(s, {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "我来分析。" },
  });
  assert.equal(s.streaming?.text, "好的，我来分析。");

  s = reduceEvent(s, { type: "turn_end", turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
  assert.equal(s.messages.filter((m) => m.kind === "assistant").length, 1);
  assert.equal(s.messages[1].text, "好的，我来分析。");
  s = reduceEvent(s, { type: "agent_end", willRetry: false });
  assert.equal(s.agentActive, false);
});

test("工具调用折叠（toolcall_start/delta/end + tool_execution_*）", async () => {
  let s = emptyTranscript();
  s = reduceEvent(s, { type: "agent_start" });
  s = reduceEvent(s, { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  s = reduceEvent(s, { type: "message_start", message: { role: "assistant", content: [] } });
  s = reduceEvent(s, {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [{ type: "toolCall", name: "read" }] } },
  });
  s = reduceEvent(s, {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"filePath":"a.ts"}' },
  });
  assert.equal(s.streaming?.tools.length, 1);
  assert.equal(s.streaming?.tools[0].name, "read");
  s = reduceEvent(s, {
    type: "message_update",
    message: { role: "assistant", content: [] },
    assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "tc1", name: "read", arguments: '{"filePath":"a.ts"}' } },
  });
  assert.equal(s.streaming?.tools[0].id, "tc1");
  s = reduceEvent(s, { type: "tool_execution_start", toolCallId: "tc1", toolName: "read", args: { filePath: "a.ts" } });
  s = reduceEvent(s, { type: "tool_execution_update", toolCallId: "tc1", toolName: "read", partialResult: { text: "文件内容..." } });
  assert.equal(s.streaming?.tools[0].output, "文件内容...");
  s = reduceEvent(s, { type: "tool_execution_end", toolCallId: "tc1", toolName: "read", result: {}, isError: false });
  assert.equal(s.streaming?.tools[0].state, "done");
  s = reduceEvent(s, { type: "turn_end", turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
  s = reduceEvent(s, { type: "agent_end", willRetry: false });
  assert.ok(s.messages.some((m) => m.kind === "assistant" && m.tools.length === 1));
});

test("todo 任务清单提取（参考图右上角面板数据源）", async () => {
  let s = emptyTranscript();
  s = reduceEvent(s, { type: "agent_start" });
  s = reduceEvent(s, { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  s = reduceEvent(s, { type: "message_start", message: { role: "assistant", content: [] } });
  s = reduceEvent(s, {
    type: "tool_execution_end", toolCallId: "tc-todo", toolName: "todo", isError: false,
    result: { details: { todos: [
      { content: "分析项目结构", status: "completed" },
      { content: "修复 bug", status: "in_progress" },
      { content: "写测试", status: "pending" },
    ] } },
  });
  assert.equal(s.todos.length, 3);
  assert.equal(s.todos[0].status, "completed");
  s = reduceEvent(s, { type: "turn_end", turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
  assert.equal(s.todos.length, 3);
});

test("LLM 错误卡（willRetry 判定，决策 D1）", async () => {
  let s = emptyTranscript();
  s = reduceEvent(s, { type: "agent_start" });
  s = reduceEvent(s, { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  s = reduceEvent(s, { type: "message_start", message: { role: "assistant", content: [] } });
  s = reduceEvent(s, { type: "turn_end", turnIndex: 0, message: { role: "assistant", stopReason: "error", errorMessage: "rate limit exceeded" } });
  assert.notEqual(s.pendingLlmError, null);
  assert.equal(s.messages.filter((m) => m.kind === "error").length, 0);

  const retry = reduceEvent(s, { type: "agent_end", willRetry: true });
  assert.equal(retry.messages.filter((m) => m.kind === "error").length, 0);
  assert.equal(retry.pendingLlmError, null);

  const final = reduceEvent(s, { type: "agent_end", willRetry: false });
  assert.equal(final.messages.filter((m) => m.kind === "error").length, 1);
});

test("buildChatRows 行分组（折叠组 + 正文边界）", async () => {
  let s = emptyTranscript();
  s = reduceEvent(s, { type: "agent_start" });
  s = reduceEvent(s, { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  s = reduceEvent(s, { type: "message_start", message: { role: "user", content: "开始" } });
  s = reduceEvent(s, { type: "message_start", message: { role: "assistant", content: [] } });
  s = reduceEvent(s, { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "思考中" } });
  s = reduceEvent(s, { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: { content: [{ type: "toolCall", name: "grep" }] } } });
  s = reduceEvent(s, { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "结论在这里" } });
  s = reduceEvent(s, { type: "turn_end", turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
  s = reduceEvent(s, { type: "agent_end", willRetry: false });
  const rows = buildChatRows(s, "sess1", Date.now());
  assert.ok(rows.some((r) => r.kind === "metaGroup"));
  assert.ok(rows.some((r) => r.kind === "message"));
  assert.ok(rows.some((r) => r.kind === "message" && r.streaming === false));
});

test("messagesToUIMessages 历史回放（历史会话重开，保留 entryId）", async () => {
  const history = [
    { role: "user", text: "历史问题", thinking: "", tools: [], images: [], timestamp: 1, entryId: "e1" },
    { role: "assistant", text: "历史回答", thinking: "思考", tools: [{ id: "h1", name: "read", args: '{"filePath":"b.ts"}', output: "内容", isError: false }], images: [], timestamp: 2, entryId: "e2" },
  ];
  const ui = messagesToUIMessages(history);
  assert.equal(ui.length, 2);
  assert.ok(ui[1].kind === "assistant" && ui[1].tools.length === 1);
  assert.equal(ui[1].entryId, "e2");
});
