"use client";
/**
 * components/percho/Markdown.tsx —— markstream-react 平滑流式 Markdown 渲染。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/Markdown.tsx
 * 适配：useThemeStore → 由调用方传 isDark（pi-web 主题状态在 useTheme hook）。
 * 扩展：外层 onClickCapture 拦截链接点击——本地文件路径经 resolveLocalFileHref 解析后
 *       交给 onOpenFile 在右侧打开；http(s) 外链交给 onOpenWebUrl 在右侧浏览器打开。
 */
import MarkdownRender, { type SmoothMarkdownStreamOptions } from "markstream-react";
import "markstream-react/index.css";
import { useRef, type MouseEvent } from "react";
import { resolveLocalFileHref } from "@/lib/file-links";

const SMOOTH_OPTIONS: SmoothMarkdownStreamOptions = {
	minCharsPerSecond: 80,
};

const CODE_BLOCK_PROPS = {
	showFontSizeButtons: false,
	showExpandButton: false,
	showPreviewButton: false,
	showCollapseButton: false,
	monacoOptions: {
		renderLineHighlight: "none",
		overviewRulerLanes: 0,
		renderOverviewRuler: false,
		overviewRulerBorder: false,
		hideCursorInOverviewRuler: true,
	},
} as const;

const REDUCED_MOTION =
	typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Markdown({
	text,
	streaming,
	isDark,
	cwd,
	onOpenFile,
	onOpenWebUrl,
}: {
	text: string;
	streaming?: boolean;
	isDark?: boolean;
	/** 会话工作目录（解析相对路径用） */
	cwd?: string;
	onOpenFile?: (filePath: string) => void;
	onOpenWebUrl?: (url: string) => void;
}) {
	// 挂载初值锁定：流式中挂载 → 本次生命周期始终启用平滑；历史消息挂载 → 永不启用
	const smoothableRef = useRef<boolean>(Boolean(streaming) && !REDUCED_MOTION);

	// 捕获 markstream 渲染出的 <a> 点击：本地文件 → onOpenFile，http(s) → onOpenWebUrl
	const handleLinkClick = (event: MouseEvent<HTMLDivElement>) => {
		if (event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const anchor = event.target instanceof Element ? event.target.closest("a") : null;
		if (!anchor) return;
		const href = anchor.getAttribute("href");
		if (!href) return;
		const target = anchor.getAttribute("target");
		if (target && target !== "_self") return;

		const filePath = resolveLocalFileHref(href, cwd);
		if (filePath) {
			event.preventDefault();
			onOpenFile?.(filePath);
			return;
		}
		if (onOpenWebUrl && /^https?:\/\//i.test(href)) {
			event.preventDefault();
			onOpenWebUrl(href);
		}
	};

	return (
		<div
			className="markdown-body text-[14px] leading-relaxed text-ink select-text"
			onClickCapture={handleLinkClick}
		>
			<MarkdownRender
				content={text}
				final={!streaming}
				fade={!REDUCED_MOTION}
				smoothStreaming={smoothableRef.current}
				smoothStreamingOptions={SMOOTH_OPTIONS}
				isDark={isDark === true}
				codeBlockLightTheme="vitesse-light"
				codeBlockDarkTheme="vitesse-dark"
				codeBlockProps={CODE_BLOCK_PROPS}
				deferNodesUntilVisible={false}
			/>
		</div>
	);
}
