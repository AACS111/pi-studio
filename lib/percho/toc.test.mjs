/**
 * lib/percho/toc.test.mjs —— Notion 风格会话目录的标题提取测试。
 * 验证 extractTocEntries：层级/文本解析、代码块内 # 跳过、非 assistant 消息忽略、
 * 多消息序号独立、闭合 # 去除、空标题丢弃。
 *
 * 跑法：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/percho/toc.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractTocEntries } from "./toc-entries.ts";

test("toc：提取标题层级与文本，多消息 headingIndex 各自独立", () => {
	const messages = [
		{ kind: "user", id: "u1", text: "帮我写个教程", images: [], timestamp: 1 },
		{
			kind: "assistant",
			id: "a1",
			text: "# 一、总览\n正文……\n## 1、安装\n### 1.1、依赖\n## 2、配置",
			thinking: "",
			tools: [],
			timestamp: 2,
		},
		{
			kind: "assistant",
			id: "a2",
			text: "## 二、进阶\n内容",
			thinking: "",
			tools: [],
			timestamp: 3,
		},
	];
	const entries = extractTocEntries(messages);
	assert.deepEqual(
		entries.map((e) => [e.kind, e.level, e.text, e.messageId, e.headingIndex]),
		[
			["user", 0, "帮我写个教程", "u1", -1],
			["heading", 1, "一、总览", "a1", 0],
			["heading", 2, "1、安装", "a1", 1],
			["heading", 3, "1.1、依赖", "a1", 2],
			["heading", 2, "2、配置", "a1", 3],
			["heading", 2, "二、进阶", "a2", 0],
		],
	);
});

test("toc：跳过代码块内的 # 注释行，闭合 # 去除", () => {
	const messages = [
		{
			kind: "assistant",
			id: "a1",
			text: [
				"# 标题甲",
				"```bash",
				"# 这不是标题",
				"```",
				"## 闭合井号标题 ##",
				"```python",
				"# 还是不算",
				"### 代码块内的也不算",
				"```",
				"#### 四级标题",
			].join("\n"),
			thinking: "",
			tools: [],
			timestamp: 1,
		},
	];
	const entries = extractTocEntries(messages);
	assert.deepEqual(
		entries.map((e) => [e.level, e.text]),
		[
			[1, "标题甲"],
			[2, "闭合井号标题"],
			[4, "四级标题"],
		],
	);
});

test("toc：用户消息产出分隔节点；system/空正文/空标题/五级以上不算", () => {
	const messages = [
		{ kind: "user", id: "u1", text: "# 用户消息里的标题不算", images: [], timestamp: 1 },
		{ kind: "system", id: "s1", text: "# 系统消息不算", timestamp: 2 },
		{ kind: "assistant", id: "a1", text: "", thinking: "", tools: [], timestamp: 3 },
		{ kind: "assistant", id: "a2", text: "##### 五级不算\n###### 六级不算\n#\n## ", thinking: "", tools: [], timestamp: 4 },
	];
	assert.deepEqual(extractTocEntries(messages), [
		{ kind: "user", level: 0, text: "# 用户消息里的标题不算", messageId: "u1", headingIndex: -1 },
	]);
});

test("toc：用户消息图片/技能作为分隔节点，空用户消息不产出", () => {
	const messages = [
		{ kind: "user", id: "u1", text: "", images: [], skill: { name: "sheet-edit" }, timestamp: 1 },
		{ kind: "user", id: "u2", text: "", images: [{ data: "AA", mimeType: "image/png" }], skill: undefined, timestamp: 2 },
		{ kind: "user", id: "u3", text: "   ", images: [], skill: undefined, timestamp: 3 },
	];
	const entries = extractTocEntries(messages);
	assert.deepEqual(entries.map((e) => [e.kind, e.text, e.messageId]), [
		["user", "sheet-edit", "u1"],
		["user", "📷 图片", "u2"],
	]);
});
