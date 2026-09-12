"use client";
/**
 * components/percho/UserMessage.tsx —— 用户消息气泡（缩略图 + skill 调用气泡 + 文本气泡）。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/UserMessage.tsx
 * 扩展：
 * - 气泡上方显示「发送时刻」（对话区时间节点，便于看每轮耗时）。
 * - 历史负载里图片是 mediaRef 桩（不内联 base64）→ <img loading="lazy"> 按需拉取。
 */
import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { UIMessage } from "@/lib/percho";
import { imageSrc, ImagePreviewOverlay } from "./ImagePreview";
import { MessageClock } from "./TurnTiming";

export function UserMessage({
	message,
	sessionId,
}: {
	message: Extract<UIMessage, { kind: "user" }>;
	sessionId?: string | null;
}) {
	const { t } = useI18n();
	const [previewIndex, setPreviewIndex] = useState<number | null>(null);

	return (
		<div className="group flex justify-end" data-toc-message-id={message.id} data-entry-id={message.entryId} data-pi-user-msg="">
			<div className="max-w-[85%]">
				<MessageClock ts={message.timestamp} />
				{message.images.length > 0 && (
					<div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
						{message.images.map((image, index) => (
							<button
								key={index}
								type="button"
								className="h-16 w-16 overflow-hidden rounded-lg border border-border"
								onClick={() => setPreviewIndex(index)}
							>
								<img
									src={imageSrc(image, sessionId)}
									alt={`${t("composer.previewImage")} ${index + 1}`}
									loading="lazy"
									decoding="async"
									className="h-full w-full object-cover"
								/>
							</button>
						))}
					</div>
				)}
				{message.skill ? (
					<div className="percho-user-bubble rounded-2xl rounded-br-md px-3.5 py-2 text-[14px] leading-relaxed text-ink select-text">
						<div
							className={
								message.text
									? "mb-1 font-mono text-[12px] text-ink-dim"
									: "font-mono text-[12px] text-ink-dim"
							}
						>
							{t("message.skillInvocation", { name: message.skill.name })}
						</div>
						{message.text && <div className="whitespace-pre-wrap break-words">{message.text}</div>}
					</div>
				) : (
					message.text && (
						<div className="percho-user-bubble rounded-2xl rounded-br-md px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap break-words text-ink select-text">
							{message.text}
						</div>
					)
				)}
			</div>
			{previewIndex !== null && (
				<ImagePreviewOverlay
					images={message.images}
					initialIndex={previewIndex}
					onClose={() => setPreviewIndex(null)}
					sessionId={sessionId}
				/>
			)}
		</div>
	);
}
