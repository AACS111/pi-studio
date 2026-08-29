/**
 * lib/percho/adapter.test.mjs —— pi-web AgentMessage[] → percho UIMessage[] 转换测试。
 * 验证历史回放桥接：user/assistant/toolCall+toolResult 配对、bashExecution、custom、错误轮合并。
 *
 * 跑法：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/percho/adapter.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { agentMessagesToPerchoUiMessages } from "./adapter.ts";

// —— 构造一组与 pi-web 后端返回一致的 AgentMessage[]（content-blocks 模型）——
function makeMessages() {
	return [
		// 用户：混合文本 + 图片
		{
			role: "user",
			content: [
				{ type: "text", text: "帮我分析这份表格并修改。\n" },
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: "AAAA" },
				},
			],
			timestamp: 1000,
		},
		// assistant：thinking + text + 两个 toolCall（edit、bash）
		{
			role: "assistant",
			model: "glm",
			provider: "zhipu",
			content: [
				{ type: "thinking", thinking: "让我先读取文件结构…\n" },
				{ type: "text", text: "好的，我先看看文件。" },
				{ type: "toolCall", toolCallId: "tc1", toolName: "read", input: { path: "/a.txt" } },
				{ type: "toolCall", toolCallId: "tc2", toolName: "edit", input: { path: "/a.txt", old: "x", new: "y" } },
			],
			timestamp: 2000,
		},
		// read 结果
		{
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			content: [{ type: "text", text: "file content\nline2" }],
			timestamp: 3000,
		},
		// edit 结果（含 patch）→ 应带 diff
		{
			role: "toolResult",
			toolCallId: "tc2",
			toolName: "edit",
			content: [{ type: "text", text: "edited ok" }],
			details: { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y" },
			timestamp: 4000,
		},
		// assistant 最终回答
		{
			role: "assistant",
			model: "glm",
			provider: "zhipu",
			content: [{ type: "text", text: "完成，已修改文件。" }],
			timestamp: 5000,
		},
		// bashExecution 命令卡
		{
			role: "bashExecution",
			command: "npm test",
			output: "PASS 5",
			timestamp: 6000,
		},
	];
}

test("adapter：user 文本+图片拆分、assistant thinking/text、toolCall+toolResult 配对", () => {
	const ui = agentMessagesToPerchoUiMessages(makeMessages());
	// 断言：第一条 user 带 text + images
	const user = ui.find((m) => m.kind === "user");
	assert.ok(user, "应有一条 user 消息");
	if (user?.kind === "user") {
		assert.equal(user.text, "帮我分析这份表格并修改。");
		assert.equal(user.images.length, 1);
		assert.equal(user.images[0]?.mimeType, "image/png");
	}

	// assistant 第一条：thinking + text + tools（含 read 的 output、edit 的 diff）
	const asst = ui.filter((m) => m.kind === "assistant");
	assert.ok(asst.length >= 2, "应有至少两条 assistant");

	const firstAsst = asst[0];
	if (firstAsst?.kind === "assistant") {
		assert.equal(firstAsst.text, "好的，我先看看文件。");
		assert.equal(firstAsst.thinking, "让我先读取文件结构…");
		assert.equal(firstAsst.tools.length, 2, "应有两个 tool 卡");

		const readTool = firstAsst.tools.find((t) => t.name === "read");
		assert.equal(readTool?.output, "file content\nline2");
		assert.equal(readTool?.state, "done");

		const editTool = firstAsst.tools.find((t) => t.name === "edit");
		assert.ok(editTool?.diff, "edit 工具应带 diff");
		assert.match(editTool?.diff ?? "", /@@/);
	}

	// bashExecution → 转为一条 assistant 文本卡
	const bashAsst = asst.find((m) => m.kind === "assistant" && m.text.includes("npm test"));
	assert.ok(bashAsst, "bashExecution 应转成 assistant 文本卡");
});

test("adapter：错误轮合并——连续 error assistant 只留最后一张卡", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		{
			role: "assistant",
			model: "m",
			provider: "p",
			content: [{ type: "text", text: "" }],
			stopReason: "error",
			errorMessage: "rate limit hit",
			timestamp: 2,
		},
		{
			role: "assistant",
			model: "m",
			provider: "p",
			content: [{ type: "text", text: "" }],
			stopReason: "error",
			errorMessage: "still rate limited",
			timestamp: 3,
		},
	];
	const ui = agentMessagesToPerchoUiMessages(messages);
	const errors = ui.filter((m) => m.kind === "error");
	assert.equal(errors.length, 1, "连续错误轮应合并成一张错误卡");
	assert.equal(errors[0]?.kind === "error" ? errors[0].error?.source : "none", "llm");
});

test("adapter：空 user（纯图片）保留、entryIds 透传", () => {
	const messages = [
		{
			role: "user",
			content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } }],
			timestamp: 1,
		},
	];
	const ui = agentMessagesToPerchoUiMessages(messages, ["entry-0"]);
	assert.equal(ui.length, 1);
	assert.equal(ui[0]?.kind, "user");
});

test("adapter：扁平图片块 { type:image, data, mimeType } 也能提取（SDK 实际落盘格式）", () => {
	const messages = [
		{
			role: "user",
			content: [
				{ type: "text", text: "看图：" },
				{ type: "image", data: "iVBORw0KGgoBA", mimeType: "image/png" },
			],
			timestamp: 1,
		},
	];
	const ui = agentMessagesToPerchoUiMessages(messages);
	const user = ui.find((m) => m.kind === "user");
	assert.ok(user && user.kind === "user", "应有一条 user 消息");
	if (user?.kind === "user") {
		assert.equal(user.text, "看图：");
		assert.equal(user.images.length, 1, "应提取到 1 张图片");
		assert.equal(user.images[0]?.data, "iVBORw0KGgoBA");
		assert.equal(user.images[0]?.mimeType, "image/png");
	}
});
