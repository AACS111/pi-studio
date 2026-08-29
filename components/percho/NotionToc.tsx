"use client";
/**
 * components/percho/NotionToc.tsx —— Notion 风格会话目录（TOC）。
 * 参考效果（用户图2/图3）：
 * - 折叠态：右缘一列右对齐短横线（宽度按标题层级递减，当前所在节加宽加深）；
 * - 悬停态：向左展开浮动大纲卡片（圆角、阴影、层级缩进），点击标题平滑滚动到对应消息的标题位置。
 *
 * 数据源：assistant 消息正文里的 markdown 标题（# ~ ####，跳过代码块）。
 * 定位锚点：MessageItem 根元素的 data-toc-message-id + 内部 h1~h4 的序号。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { selectTranscript, useTranscriptStore } from "@/lib/percho-store";
import type { TocEntry } from "@/lib/percho/toc-entries";
import { extractTocEntries } from "@/lib/percho/toc-entries";

const PREVIEW_HIDE_DELAY = 260;
/** 少于 2 个标题不值得占用右缘空间 */
const MIN_ENTRIES = 2;

/** 横线宽度按层级递减（h1 最宽） */
function dashWidth(level: TocEntry["level"]): number {
	switch (level) {
		case 1:
			return 18;
		case 2:
			return 13;
		case 3:
			return 9;
		default:
			return 6;
	}
}

export function NotionToc({
	sessionId,
	scrollRef,
}: {
	sessionId: string;
	/** MessageList 的真实滚动容器（定位与当前节追踪都用它；由 ChatWindow 传入） */
	scrollRef: RefObject<HTMLDivElement | null>;
}) {
	// 自订阅 transcript store：目录数据随历史回放/live 事件自动更新
	const messages = useTranscriptStore((s) => selectTranscript(s, sessionId).messages);
	const entries = useMemo(() => extractTocEntries(messages), [messages]);
	const [expanded, setExpanded] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const rafRef = useRef(0);

	const cancelHide = useCallback(() => {
		if (!hideTimerRef.current) return;
		clearTimeout(hideTimerRef.current);
		hideTimerRef.current = null;
	}, []);

	const scheduleHide = useCallback(() => {
		cancelHide();
		hideTimerRef.current = setTimeout(() => {
			hideTimerRef.current = null;
			setExpanded(false);
		}, PREVIEW_HIDE_DELAY);
	}, [cancelHide]);

	useEffect(() => () => cancelHide(), [cancelHide]);

	/** 找到标题对应的 DOM 元素（消息锚点内第 headingIndex 个 h1~h4；缺失退回消息根） */
	const locate = useCallback(
		(entry: TocEntry): HTMLElement | null => {
			const el = scrollRef.current;
			if (!el) return null;
			const host = el.querySelector<HTMLElement>(`[data-toc-message-id="${CSS.escape(entry.messageId)}"]`);
			if (!host) return null;
			const heads = host.querySelectorAll<HTMLElement>("h1, h2, h3, h4");
			return heads[entry.headingIndex] ?? host;
		},
		[scrollRef],
	);

	const scrollToEntry = useCallback(
		(entry: TocEntry) => {
			const el = scrollRef.current;
			const target = locate(entry);
			if (!el || !target) return;
			const top =
				target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 28;
			el.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
			// 上滚会触发 MessageList 的 handleScroll 自动解除底部跟随，无需额外回调
		},
		[locate, scrollRef],
	);

	// 当前节追踪：滚动时取「视口焦点线（顶部 25%）」上方最近的标题
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || entries.length === 0) return;
		let disposed = false;
		const update = () => {
			if (disposed) return;
			const elTop = el.getBoundingClientRect().top;
			const focusTop = el.scrollTop + el.clientHeight * 0.25;
			let active = 0;
			for (let i = 0; i < entries.length; i++) {
				const t = locate(entries[i]);
				if (!t) continue;
				const absTop = t.getBoundingClientRect().top - elTop + el.scrollTop;
				if (absTop <= focusTop) active = i;
			}
			setActiveIndex(active);
		};
		const onScroll = () => {
			if (rafRef.current) return;
			rafRef.current = requestAnimationFrame(() => {
				rafRef.current = 0;
				update();
			});
		};
		update();
		el.addEventListener("scroll", onScroll, { passive: true });
		const ro = new ResizeObserver(onScroll);
		ro.observe(el);
		if (el.firstElementChild) ro.observe(el.firstElementChild);
		return () => {
			disposed = true;
			el.removeEventListener("scroll", onScroll);
			ro.disconnect();
			if (rafRef.current) cancelAnimationFrame(rafRef.current);
		};
	}, [entries, locate, scrollRef]);

	if (entries.length < MIN_ENTRIES) return null;

	// 横线间距随条数自适应（默认宽松，条数多时收紧防溢出）
	const dashGap = entries.length > 36 ? 4 : entries.length > 22 ? 8 : 12;

	return (
		<div
			className="absolute top-1/2 right-3 z-20 -translate-y-1/2"
			onMouseEnter={() => {
				cancelHide();
				setExpanded(true);
			}}
			onMouseLeave={scheduleHide}
		>
			{/* 折叠态：右缘短横线列（Notion 折叠 TOC）；right-3 避开最右缘滚动条 */}
			<div
				className={`flex max-h-[80vh] flex-col items-end overflow-y-auto rounded-lg py-2 pr-1 pl-2 transition-opacity duration-150 [scrollbar-width:none] ${
					expanded ? "opacity-35" : "opacity-100"
				}`}
				style={{ gap: dashGap }}
			>
				{entries.map((entry, index) => (
					<button
						key={`${entry.messageId}:${entry.headingIndex}`}
						type="button"
						aria-label={entry.text}
						title={entry.text}
						onClick={() => scrollToEntry(entry)}
						className="block h-[2px] shrink-0 cursor-pointer rounded-full transition-all duration-150"
						style={{
							width: dashWidth(entry.level),
							background:
								index === activeIndex
									? "var(--text)"
									: "color-mix(in srgb, var(--text-muted) 42%, transparent)",
						}}
					/>
				))}
			</div>
			{/* 悬停态：Notion 大纲卡片（毛玻璃，贴主题不突兀） */}
			{expanded && (
				<div className="toc-card chat-scrollbar absolute top-1/2 right-8 max-h-[72vh] w-[320px] -translate-y-1/2 overflow-y-auto rounded-2xl p-2">
					{entries.map((entry, index) => (
						<button
							key={`${entry.messageId}:${entry.headingIndex}`}
							type="button"
							onClick={() => scrollToEntry(entry)}
							title={entry.text}
							className={`toc-item ${index === activeIndex ? "is-active" : ""}`}
							style={{ paddingLeft: 10 + (entry.level - 1) * 16 }}
						>
							{entry.text}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
