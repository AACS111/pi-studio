"use client";
/**
 * components/percho/AssistantMessage.tsx —— 助手消息体：元数据（思考/工具折叠）+ Markdown 正文。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/AssistantMessage.tsx
 */
import type { UIToolCall } from "@/lib/percho";
import { Markdown } from "./Markdown";
import { MetaGroup, type MetaItem } from "./MetaGroup";

export function AssistantMessage({
	text,
	thinking,
	tools,
	streaming,
	metaInGroup = false,
	isDark,
	cwd,
	onOpenFile,
	onOpenWebUrl,
}: {
	text: string;
	thinking: string;
	tools: UIToolCall[];
	streaming?: boolean;
	metaInGroup?: boolean;
	isDark?: boolean;
	cwd?: string;
	onOpenFile?: (filePath: string) => void;
	onOpenWebUrl?: (url: string) => void;
}) {
	const items: MetaItem[] = [];
	if (!metaInGroup && (thinking || tools.length > 0)) items.push({ thinking, tools });

	return (
		<div className="flex flex-col gap-2">
			{items.length > 0 && <MetaGroup items={items} working={Boolean(streaming) && !text} />}
			{text && (
				<Markdown
					text={text}
					streaming={streaming}
					isDark={isDark}
					cwd={cwd}
					onOpenFile={onOpenFile}
					onOpenWebUrl={onOpenWebUrl}
				/>
			)}
			{streaming && !text && !thinking && tools.length === 0 && (
				<div className="flex items-center gap-1 text-ink-faint">
					<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint" />
					<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint [animation-delay:150ms]" />
					<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint [animation-delay:300ms]" />
				</div>
			)}
		</div>
	);
}
