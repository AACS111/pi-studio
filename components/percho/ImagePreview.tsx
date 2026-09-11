"use client";
/**
 * components/percho/ImagePreview.tsx —— 全屏图片预览遮罩 + imageSrc 工具。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/ImagePreview.tsx
 */
import type { ImageInput } from "@/lib/percho";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useNativeOverlayGuard } from "@/hooks/useNativeOverlayGuard";

/**
 * 图片 src：历史负载里图片不内联 base64（只剩 mediaRef 桩），此时拼成按需拉取接口；
 * 没有 mediaRef（live 流式 / 旧负载）时用内联 data URL。
 */
export function imageSrc(image: ImageInput, sessionId?: string | null): string {
	if (!image.data && image.mediaRef && sessionId) {
		return `/api/sessions/${encodeURIComponent(sessionId)}/media?ref=${encodeURIComponent(image.mediaRef)}`;
	}
	return `data:${image.mimeType};base64,${image.data}`;
}

export function ImagePreviewOverlay({
	image,
	images,
	initialIndex = 0,
	onClose,
	sessionId,
}: {
	image?: ImageInput;
	images?: ImageInput[];
	initialIndex?: number;
	onClose: () => void;
	sessionId?: string | null;
}) {
	const { t } = useI18n();
	const list = images ?? (image ? [image] : []);
	const count = list.length;
	// 原生右侧浏览器（WebContentsView）永远盖在 HTML 之上：图片预览遮罩打开期间隐藏它，
	// 否则浏览器会压住预览图右侧（z-index 再高也没用）。count=0 不渲染时不触发。
	useNativeOverlayGuard(count > 0);
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

	// z-index 必须高于全应用 chrome：左侧栏 z=200、右侧面板 z=260、各类弹窗 z=1000/1100。
	// 用 z-50 时遮罩盖不住左侧栏（侧栏玻璃背景会把深色遮罩模糊成一块灰糊）。
	return createPortal(
		<button
			type="button"
			className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-8"
			onClick={onClose}
		>
			<img
				src={imageSrc(current, sessionId)}
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
