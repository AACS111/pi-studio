"use client";
/**
 * components/percho/MessageItem.tsx —— 单条消息：按类型分发（用户气泡/图片块/子代理卡/错误卡/系统/助手）。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/MessageItem.tsx
 * 简化：fork/retry/设置跳转等动作按钮暂缺（后续桥接 pi-web rpc）。
 */
import { memo, useState } from "react";
import type { UIMessage } from "@/lib/percho";
import { AssistantMessage } from "./AssistantMessage";
import { ImagePreviewOverlay, imageSrc } from "./ImagePreview";
import { SubagentRunCard } from "./SubagentRunCard";
import { SystemMessage } from "./SystemMessage";
import { UserMessage } from "./UserMessage";

export const MessageItem = memo(function MessageItem({
	message,
	streaming,
	metaInGroup,
	isDark,
	onOpenSubagent,
	cwd,
	onOpenFile,
	onOpenWebUrl,
}: {
	message: UIMessage;
	streaming?: boolean;
	metaInGroup?: boolean;
	showActions?: boolean;
	sessionId?: string | null;
	isDark?: boolean;
	onOpenSubagent?: (sessionFile: string) => void;
	cwd?: string;
	onOpenFile?: (filePath: string) => void;
	onOpenWebUrl?: (url: string) => void;
}) {
	const [previewIndex, setPreviewIndex] = useState<number | null>(null);

	if (message.kind === "user") {
		return <UserMessage message={message} />;
	}
	if (message.kind === "image") {
		const count = message.images.length;
		const sizeClass =
			count === 1
				? "max-h-36 max-w-48 object-contain"
				: count <= 3
					? "h-24 w-24 object-cover"
					: count <= 6
						? "h-20 w-20 object-cover"
						: "h-16 w-16 object-cover";
		return (
			<div>
				<div className="flex flex-wrap gap-2">
					{message.images.map((image, index) => (
						<button
							key={index}
							type="button"
							className="overflow-hidden rounded-xl border border-border"
							onClick={() => setPreviewIndex(index)}
						>
							<img src={imageSrc(image)} alt="image" className={sizeClass} />
						</button>
					))}
				</div>
				{previewIndex !== null && (
					<ImagePreviewOverlay
						images={message.images}
						initialIndex={previewIndex}
						onClose={() => setPreviewIndex(null)}
					/>
				)}
			</div>
		);
	}
	if (message.kind === "subagent") {
		return <SubagentRunCard runs={message.runs} onOpen={onOpenSubagent} />;
	}
	if (message.kind === "error") {
		// 错误卡：简化未含 retry/compact 动作，仅展示 envelope（ErrorNote 后续接回）
		return <span className="text-[13px] text-red-500">{message.error?.detail}</span>;
	}
	if (message.kind === "system") {
		return <SystemMessage message={message} />;
	}
	return (
		<div className="group" data-toc-message-id={message.id} data-entry-id={message.entryId}>
			<AssistantMessage
				text={message.text}
				thinking={message.thinking}
				tools={message.tools}
				streaming={streaming}
				metaInGroup={metaInGroup}
				isDark={isDark}
				cwd={cwd}
				onOpenFile={onOpenFile}
				onOpenWebUrl={onOpenWebUrl}
			/>
		</div>
	);
});
