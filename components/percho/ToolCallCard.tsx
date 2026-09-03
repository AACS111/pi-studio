"use client";
/**
 * components/percho/ToolCallCard.tsx —— 工具调用行：无边框、默认折叠；单行渐变截断摘要。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/ToolCallCard.tsx
 */
import { useEffect, useRef, useState } from "react";
import type { UIToolCall } from "@/lib/percho";
import { ExpandArrowIcon } from "./icons";

export function summarizeArgs(args: string): string {
	if (!args || args === "{}") return "";
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		const command = parsed.command ?? parsed.cmd;
		if (typeof command === "string") return command;
		const filePath = parsed.filePath ?? parsed.path ?? parsed.file;
		if (typeof filePath === "string") return filePath;
		const url = parsed.url;
		if (typeof url === "string") return url;
	} catch {
		for (const key of ["command", "cmd", "filePath", "path", "file", "url"]) {
			const value = args.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))?.[1];
			if (value) return value;
		}
	}
	const trimmed = args.slice(0, 120);
	return trimmed.length < args.length ? `${trimmed}…` : trimmed;
}

export const displayName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

export function ToolCallCard({ tool }: { tool: UIToolCall }) {
	const summary = summarizeArgs(tool.args);
	const [overflowing, setOverflowing] = useState(false);
	// 工具参数/输出收起态不建 DOM（单条输出动辄几十 KB）；首次展开后保持挂载
	const [openedOnce, setOpenedOnce] = useState(false);
	const textRef = useRef<HTMLSpanElement>(null);
	const rowRef = useRef<HTMLElement>(null);

	useEffect(() => {
		const check = () => {
			const el = textRef.current;
			const row = rowRef.current;
			if (!el || !row) return;
			const left = el.getBoundingClientRect().left - row.getBoundingClientRect().left;
			setOverflowing(el.scrollWidth > row.clientWidth - left);
		};
		check();
		const row = rowRef.current;
		if (!row) return;
		const ro = new ResizeObserver(check);
		ro.observe(row);
		return () => ro.disconnect();
	}, [summary]);

	const nameClass = `shrink-0 font-mono text-[13px] font-semibold text-ink-dim transition-colors group-hover/row:text-ink${
		tool.state === "running" ? " shimmer-sweep" : ""
	}`;
	const summaryClass =
		"relative overflow-hidden whitespace-nowrap font-mono text-[12px] text-ink-faint transition-colors group-hover/row:text-ink";

	return (
		<details
			className="group/dets drawer-details"
			onToggle={(e) => {
				if (e.currentTarget.open) setOpenedOnce(true);
			}}
		>
			<summary
				ref={rowRef}
				className="group/row flex cursor-pointer items-center gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden"
			>
				<span className={nameClass}>{displayName(tool.name)}</span>
				{summary && (
					<span
						ref={textRef}
						className={overflowing ? `${summaryClass} min-w-0 flex-1` : `${summaryClass} shrink-0`}
					>
						{summary}
						{overflowing && (
							<span className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-canvas to-transparent" />
						)}
					</span>
				)}
				{tool.state === "running" && summary && (
					<span className="shrink-0 font-mono text-[12px] text-ink-faint transition-colors group-hover/row:text-ink-2">
						…
					</span>
				)}
				<ExpandArrowIcon className="shrink-0 text-ink-faint opacity-0 transition-[opacity,transform,color] group-hover/row:opacity-100 group-hover/row:text-ink-2 group-open/dets:rotate-90" />
			</summary>
			<div className="flex flex-col gap-1.5 py-1 pl-4">
				{openedOnce && tool.args && (
					<pre className="max-h-56 overflow-y-auto font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-ink-dim select-text">
						{tool.args}
					</pre>
				)}
				{openedOnce && tool.output && (
					<pre className="max-h-56 overflow-y-auto font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-ink-2 select-text">
						{tool.output}
					</pre>
				)}
			</div>
		</details>
	);
}
