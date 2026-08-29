/**
 * lib/percho-store.test.mjs —— percho transcript store（zustand 运行时桥接层）端到端测试。
 * 验证 pi-web SSE 事件（含 todo/tool_execution_* 增量）经 applyEvent 正确归约进 store，
 * 供 percho 呈现层（TodoPanel / MessageList / 错误卡）消费。
 *
 * 跑法：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/percho/store.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { useTranscriptStore } from "../percho-store.ts";

test("bridge 事件归约：tool_execution_end(todo) 写入任务清单，agent 状态联动", async () => {
	useTranscriptStore.getState().resetSession("s1");
	useTranscriptStore.getState().applyEvent("s1", { type: "agent_start" });
	assert.equal(useTranscriptStore.getState().bySession["s1"]?.agentActive, true);

	useTranscriptStore.getState().applyEvent("s1", {
		type: "tool_execution_end",
		toolCallId: "tc-todo",
		toolName: "todo",
		isError: false,
		result: {
			details: {
				todos: [
					{ content: "分析项目结构", status: "completed" },
					{ content: "修复 bug", status: "in_progress" },
					{ content: "写测试", status: "pending" },
				],
			},
		},
	});
	const entry = useTranscriptStore.getState().bySession["s1"];
	assert.equal(entry?.todos?.length, 3);
	assert.equal(entry?.todos?.[0]?.status, "completed");

	useTranscriptStore.getState().applyEvent("s1", { type: "agent_end", willRetry: false });
	assert.equal(useTranscriptStore.getState().bySession["s1"]?.agentActive, false);
});

test("bridge 事件归约：turn_start/turn_end/assistantMessageEvent 进入消息流", async () => {
	useTranscriptStore.getState().resetSession("s2");
	useTranscriptStore.getState().applyEvent("s2", { type: "agent_start" });
	useTranscriptStore.getState().applyEvent("s2", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	useTranscriptStore.getState().applyEvent("s2", { type: "message_start", message: { role: "user", content: "你好" } });
	useTranscriptStore.getState().applyEvent("s2", { type: "message_start", message: { role: "assistant", content: [] } });
	useTranscriptStore.getState().applyEvent("s2", {
		type: "message_update",
		message: { role: "assistant", content: [] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你好，" },
	});
	useTranscriptStore.getState().applyEvent("s2", {
		type: "message_update",
		message: { role: "assistant", content: [] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "世界" },
	});
	// 流式中：user 已固化进 messages，assistant 仍在 streaming 容器（text 累积）
	const entry = useTranscriptStore.getState().bySession["s2"];
	assert.equal(entry?.messages?.length, 1); // 仅 user
	assert.equal(entry?.messages?.[0]?.kind, "user");
	assert.equal(entry?.streaming?.text, "你好，世界");
	// 固化：turn_end 后 assistant 进 messages
	useTranscriptStore.getState().applyEvent("s2", { type: "turn_end", turnIndex: 0, message: { role: "assistant" }, toolResults: [] });
	const done = useTranscriptStore.getState().bySession["s2"];
	assert.equal(done?.messages?.length, 2);
	assert.equal(done?.messages?.[1]?.kind, "assistant");
	assert.equal(done?.messages?.[1]?.text, "你好，世界");
	assert.equal(done?.streaming, null);
});
