/**
 * lib/percho/adapter.ts —— pi-web AgentMessage[] → percho SessionMessage[] 的桥接转换。
 *
 * 背景：pi-web 用「content blocks」模型（toolCall / toolResult 分属 assistant 与独立消息），
 * percho 用「扁平」模型（assistant.text + thinking + tools[]，tool 的 output/diff 并进 tools 卡）。
 * 打开历史会话时，percho 呈现层需要 UIMessage[]；本 adapter 把 pi-web 的历史消息
 * 转成 percho 的 SessionMessage[]，再复用 lib/percho/transcript/mapping.ts 的
 * messagesToUIMessages()（它已处理连续错误轮合并、image/subagent 拆分、错误卡挂起）。
 *
 * 只做「展示转换」，不改动 pi-web 自身的 messages 状态。
 */
import type {
	AgentMessage,
	AssistantContentBlock,
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@/lib/types";
import { messagesToUIMessages } from "@/lib/percho";
import type { SessionMessage, SessionToolCall } from "@/lib/percho";
import type { UIMessage } from "@/lib/percho";

/** 从 content blocks 提取纯文本（text block 拼接；忽略 image/thinking/toolCall） */
function extractText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => (block as TextContent).text)
		.join("\n");
}

/**
 * 从 content blocks 提取 images（→ { data, mimeType }，data 为纯 base64，不含 data URL 前缀）。
 * 兼容两种落盘格式：
 * - Anthropic 块：{ type:"image", source:{ data, media_type } }（lib/types 声明的 shape）
 * - 扁平块：{ type:"image", data, mimeType }（SDK 实际写入历史会话的格式，live reducer 亦用此）
 */
function extractImages(content: string | (TextContent | ImageContent)[]): { data: string; mimeType: string }[] {
	if (typeof content === "string") return [];
	return content
		.filter((block) => block.type === "image")
		.map((block) => {
			const img = block as ImageContent & { data?: unknown; mimeType?: unknown };
			const source = img.source as { data?: unknown; media_type?: unknown } | undefined;
			const data =
				(typeof source?.data === "string" && source.data) ||
				(typeof img.data === "string" ? img.data : "");
			const mimeType =
				(typeof source?.media_type === "string" && source.media_type) ||
				(typeof img.mimeType === "string" ? img.mimeType : "") ||
				"image/png";
			return { data, mimeType };
		})
		.filter((img) => img.data.length > 0);
}

/** 从 ToolResultMessage 提取 output 文本（content 的 text block 拼接） */
function extractToolOutput(result: ToolResultMessage): string {
	return extractText(result.content);
}

/** 从 ToolResultMessage 提取 edit unified patch（details.patch），非 edit/无 patch 返回 null */
function extractToolDiff(result: ToolResultMessage): string | null {
	const details = result.details as { patch?: unknown } | null | undefined;
	const patch = details?.patch;
	return typeof patch === "string" && patch.length > 0 ? patch : null;
}

/** assistant content 里的 toolCall block 集合 + 对应 toolResult（按 toolCallId 配对） */
function buildToolCalls(
	blocks: AssistantContentBlock[],
	toolResults: Map<string, ToolResultMessage>,
): SessionToolCall[] {
	const tools: SessionToolCall[] = [];
	for (const block of blocks) {
		if (block.type !== "toolCall") continue;
		const result = toolResults.get(block.toolCallId);
		const args = (() => {
			try {
				return JSON.stringify(block.input ?? {});
			} catch {
				return "{}";
			}
		})();
		const diff = result ? extractToolDiff(result) : null;
		tools.push({
			id: block.toolCallId,
			name: block.toolName,
			args,
			output: result ? extractToolOutput(result) : "",
			...(diff ? { diff } : {}),
			isError: result?.isError ?? false,
		});
	}
	return tools;
}

/** 从 assistant content 提取 thinking（thinking block 拼接） */
function extractThinking(blocks: AssistantContentBlock[]): string {
	return blocks
		.filter((b): b is Extract<AssistantContentBlock, { type: "thinking" }> => b.type === "thinking")
		.map((b) => b.thinking)
		.join("\n")
		.trim();
}

/**
 * pi-web AgentMessage[] → percho SessionMessage[]。
 * @param messages pi-web 会话消息（历史或 live 已归并）
 * @param entryIds 可选；用于给 user/assistant 消息标注 entryId（fork/撤回精确定位）
 */
export function agentMessagesToPerchoSession(
	messages: AgentMessage[],
	entryIds?: string[],
): SessionMessage[] {
	// 第一步：配对 toolCall → toolResult（pi-web 的 toolResult 是独立消息，需按 toolCallId 归并进 assistant 的 tools）
	const toolResults = new Map<string, ToolResultMessage>();
	for (const msg of messages) {
		if (msg?.role === "toolResult") toolResults.set(msg.toolCallId, msg);
	}

	const out: SessionMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;
		try {
			const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
			const entryId = entryIds?.[i];
			switch (msg.role) {
			case "user": {
				const user = msg as UserMessage;
				const text = extractText(user.content).trim();
				const images = extractImages(user.content);
				// 空 user 消息（纯图片也保留），skill 没有则省略
				if (text.length === 0 && images.length === 0) break;
				out.push({
					role: "user",
					text,
					thinking: "",
					tools: [],
					images,
					timestamp,
					...(entryId ? { entryId } : {}),
				});
				break;
			}
			case "assistant": {
				const asst = msg as AssistantMessage;
				const text = asst.content
					.filter((b) => b.type === "text")
					.map((b) => (b as TextContent).text)
					.join("\n");
				const images: { data: string; mimeType: string }[] = [];
				const thinking = extractThinking(asst.content);
				const tools = buildToolCalls(asst.content, toolResults);
				out.push({
					role: "assistant",
					text,
					thinking,
					tools,
					images,
					timestamp,
					...(entryId ? { entryId } : {}),
					...(asst.stopReason ? { stopReason: asst.stopReason } : {}),
					...(asst.errorMessage ? { errorMessage: asst.errorMessage } : {}),
				});
				break;
			}
			case "toolResult":
				// 不入独立消息（output/diff 已并进 assistant 的 tools 卡）
				break;
			case "bashExecution": {
				// pi-web 专用命令执行消息：percho 无对应角色，渲染成一条 assistant 文本（保留命令+输出）
				const bash = msg as Extract<AgentMessage, { role: "bashExecution" }>;
				const text = `$ ${bash.command}\n\n${bash.output ?? ""}`.trim();
				if (text.length === 0) break;
				out.push({ role: "assistant", text, thinking: "", tools: [], images: [], timestamp });
				break;
			}
			case "custom": {
				const custom = msg as Extract<AgentMessage, { role: "custom" }>;
				if (custom.display !== false) {
					const text = extractText(custom.content).trim();
					if (text.length > 0) {
						out.push({ role: "assistant", text, thinking: "", tools: [], images: [], timestamp });
					}
				}
				break;
			}
			default:
				break;
			}
		} catch {
			// 单条消息转换失败：跳过该条，绝不阻断整个历史回放（避免一条坏数据导致整屏空白）
			console.warn("percho adapter skip message", i, msg.role);
		}
	}
	return out;
}

/** 便捷包装：AgentMessage[] → UIMessage[]（直接喂 percho store.loadHistory） */
export function agentMessagesToPerchoUiMessages(
	messages: AgentMessage[],
	entryIds?: string[],
): UIMessage[] {
	return messagesToUIMessages(agentMessagesToPerchoSession(messages, entryIds));
}
