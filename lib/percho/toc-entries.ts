/**
 * lib/percho/toc-entries.ts —— Notion 风格会话目录的纯数据层：
 * 从 percho transcript 的 assistant 消息正文提取 markdown 标题大纲（# ~ ####，跳过代码块）。
 * 纯函数、无 JSX / React 依赖，可被 node 测试直接加载（.tsx 含 JSX 不能进 node --test）。
 */
import type { UIMessage } from "@/lib/percho";

export interface TocEntry {
	/** heading = 助手正文里的 markdown 标题；user = 用户发送的消息（作为节点分割线） */
	kind: "heading" | "user";
	/** 0 = 用户分隔节点；1~4 = 标题层级 */
	level: 0 | 1 | 2 | 3 | 4;
	text: string;
	/** 所在消息 id（MessageItem 根元素 data-toc-message-id） */
	messageId: string;
	/** 该消息内第几个标题（h1~h4 查询序号）；user 用 -1（定位到消息根） */
	headingIndex: number;
}

const HEADING_RE = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const CODE_FENCE_RE = /^\s*```/;

/**
 * 从 transcript 消息提取目录条目：
 * - 助手消息 → 提取 markdown 标题大纲（# ~ ####，跳过代码块内的 # 注释行）；
 * - 用户消息 → 作为一条「分割线」节点（kind="user"，level=0），方便定位到每次发送的位置。
 * 按消息顺序穿插，保持对话节奏。
 */
export function extractTocEntries(messages: UIMessage[]): TocEntry[] {
	const entries: TocEntry[] = [];
	for (const m of messages) {
		if (m.kind === "user") {
			const text =
				m.text.trim() ||
				(m.skill ? m.skill.name : m.images?.length ? "📷 图片" : "");
			if (!text) continue;
			entries.push({ kind: "user", level: 0, text, messageId: m.id, headingIndex: -1 });
			continue;
		}
		if (m.kind !== "assistant" || !m.text) continue;
		let inCode = false;
		let headingIndex = 0;
		for (const raw of m.text.split("\n")) {
			const line = raw.trimEnd();
			if (CODE_FENCE_RE.test(line)) {
				inCode = !inCode;
				continue;
			}
			if (inCode) continue;
			const match = HEADING_RE.exec(line);
			if (!match) continue;
			const text = match[2].trim();
			if (!text) continue;
			entries.push({
				kind: "heading",
				level: match[1].length as TocEntry["level"],
				text,
				messageId: m.id,
				headingIndex,
			});
			headingIndex++;
		}
	}
	return entries;
}
