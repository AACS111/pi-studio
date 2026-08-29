"use client";
/**
 * components/percho/UserMessage.tsx —— 用户消息气泡（缩略图 + skill 调用气泡 + 文本气泡）。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/UserMessage.tsx
 * 简化：操作行（复制/撤回）暂不含，后续桥接 pi-web 能力。
 */
import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { UIMessage } from "@/lib/percho";
import { ImagePreviewOverlay, imageSrc } from "./ImagePreview";

export function UserMessage({ message }: { message: Extract<UIMessage, { kind: "user" }> }) {
	const { t } = useI18n();
	const [previewIndex, setPreviewIndex] = useState<number | null>(null);

	return (
		<div className="group flex justify-end">
			<div className="max-w-[85%]">
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
									src={imageSrc(image)}
									alt={`${t("composer.previewImage")} ${index + 1}`}
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
				{message.skill && message.text && (
					<div className="mt-1 flex items-center justify-end gap-1">
						{/* skill 命令复制（简化：仅展示，操作按钮后续接回） */}
					</div>
				)}
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
