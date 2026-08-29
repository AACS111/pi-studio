"use client";
/**
 * components/percho/ImagePreview.tsx —— 全屏图片预览遮罩 + imageSrc 工具。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/ImagePreview.tsx
 */
import type { ImageInput } from "@/lib/percho";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";

export function imageSrc(image: ImageInput): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

export function ImagePreviewOverlay({
	image,
	images,
	initialIndex = 0,
	onClose,
}: {
	image?: ImageInput;
	images?: ImageInput[];
	initialIndex?: number;
	onClose: () => void;
}) {
	const { t } = useI18n();
	const list = images ?? (image ? [image] : []);
	const count = list.length;
	const [index, setIndex] = useState(() => Math.min(initialIndex, count - 1));
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				onCloseRef.current();
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				setIndex((i) => Math.max(0, i - 1));
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				setIndex((i) => Math.min(count - 1, i + 1));
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [count]);

	if (count === 0) return null;
	const current = list[index];
	if (!current) return null;

	return createPortal(
		<button
			type="button"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8"
			onClick={onClose}
		>
			<img
				src={imageSrc(current)}
				alt={t("message.image")}
				className="max-h-full max-w-full rounded-lg object-contain"
			/>
			{count > 1 && (
				<span className="absolute top-4 right-5 rounded-full bg-black/50 px-2.5 py-1 text-[11px] text-white/80 select-none">
					{index + 1} / {count}
				</span>
			)}
		</button>,
		document.body,
	);
}
