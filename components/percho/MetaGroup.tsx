"use client";
/**
 * components/percho/MetaGroup.tsx —— 外层折叠组：聚合多条非正文消息的思考/工具。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/MetaGroup.tsx
 * 简化：去掉 ThinkingOrb 中央动画 / PreviewTicker 流光 / use-sweep-highlight 扫光 / Slot 插件槽，
 *     保留折叠组核心（working 标题 + 圆点行 + worked 分类汇总 + 展开区思考行/工具卡）。
 *     动画层后续接回（对应 percho 原版）。
 */
import { dotsFromItems, type MetaDot, type MetaItem, summarizeCategories } from "@/lib/percho";
import { Fragment, memo, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { loadThinkingContent } from "@/lib/thinking";
import { ExpandArrowIcon } from "./icons";
import { summaryLabel } from "./meta-summary-label";
import { ToolCallCard } from "./ToolCallCard";
import { useShownWorking } from "./use-shown-working";

export type { MetaItem };

/** 思考过程行（内层折叠，与 tool call 行同风格）。
 *  历史会话里思考正文被 deferThinking 剔掉（thinking 为 "" + thinkingRef），首次展开才拉取，
 *  满足「折叠内容不提前渲染」；live 流式思考直接有正文，无需拉取。 */
function ThinkingRow({
	thinking,
	ref,
	sessionId,
}: {
	thinking: string;
	ref?: { entryId: string; blockIndex: number };
	sessionId?: string | null;
}) {
	const { t } = useI18n();
	// 收起态不挂正文：历史会话动辄上百条思考，展开时再渲染（首次开一下后保持挂载）
	const [openedOnce, setOpenedOnce] = useState(false);
	const [deferredText, setDeferredText] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!openedOnce || !ref || deferredText !== null || thinking) return;
		if (!sessionId) {
			setError(t("i18n.thinkingUnavailable"));
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		loadThinkingContent(sessionId, ref.entryId, ref.blockIndex)
			.then((text) => {
				if (!cancelled) setDeferredText(text || "");
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [openedOnce, ref, deferredText, thinking, sessionId, t]);

	const body = thinking || deferredText || "";
	return (
		<details
			className="group/dets drawer-details"
			onToggle={(e) => {
				if (e.currentTarget.open) setOpenedOnce(true);
			}}
		>
			<summary className="group/row flex cursor-pointer items-center gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 text-[13px] font-semibold text-ink-faint transition-colors group-hover/row:text-ink">
					{t("message.thinking")}
				</span>
				<ExpandArrowIcon className="shrink-0 text-ink-faint opacity-0 transition-[opacity,transform,color] group-hover/row:opacity-100 group-hover/row:text-ink-2 group-open/dets:rotate-90" />
			</summary>
			{openedOnce && (
				<div className="py-1 pl-4 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink-dim select-text">
					{loading
						? t("i18n.loadingThinking")
						: error ?? (body.length > 0 ? body : "")}
				</div>
			)}
		</details>
	);
}

/** 进度刻度：done = 细实心刻度，error = 琥珀红，running = accent 实心呼吸（globals.css meta-dot-running）。
 *  原先 4px 圆点串在多工具时读起来像噪点，改成 3×8 的短刻度更像进度指示。 */
function dotClass(state: MetaDot["state"]): string {
	const base = "h-[3px] w-2 shrink-0 rounded-full transition-colors";
	if (state === "running") return `${base} meta-dot-running`;
	return state === "error" ? `${base} bg-red-500/80` : `${base} bg-ink-faint`;
}

function metaGroupPropsEqual(
	a: { items: MetaItem[]; working: boolean; endImmediately?: boolean; subagentCount?: number; sessionId?: string | null },
	b: { items: MetaItem[]; working: boolean; endImmediately?: boolean; subagentCount?: number; sessionId?: string | null },
): boolean {
	if (
		a.working !== b.working ||
		a.endImmediately !== b.endImmediately ||
		a.subagentCount !== b.subagentCount ||
		a.sessionId !== b.sessionId ||
		a.items.length !== b.items.length
	)
		return false;
	for (let i = 0; i < a.items.length; i++) {
		if (a.items[i] !== b.items[i]) return false;
	}
	return true;
}

export const MetaGroup = memo(function MetaGroup({
	items,
	working,
	endImmediately = false,
	subagentCount = 0,
	sessionId,
}: {
	items: MetaItem[];
	working: boolean;
	endImmediately?: boolean;
	subagentCount?: number;
	/** 会话 id（延期思考按需拉取用） */
	sessionId?: string | null;
}) {
	const { t } = useI18n();
	// 折叠组体（思考行 + 工具卡）默认不挂载：展开那一刻才建 DOM。
	// 长会话首屏能省掉上百个 <pre>（工具输出动辄几十 KB）+ 同样多的 ResizeObserver。
	const [openedOnce, setOpenedOnce] = useState(false);
	const count = items.reduce(
		(n, item) => n + (item.thinking || item.thinkingRef ? 1 : 0) + item.tools.length,
		0,
	);
	const dots = useMemo(() => dotsFromItems(items), [items]);
	const segments = useMemo(() => summarizeCategories(items, subagentCount), [items, subagentCount]);

	const shownWorking = useShownWorking(working, endImmediately);

	const rows = items.flatMap((item, i) => [
		item.thinking || item.thinkingRef ? (
			<ThinkingRow
				key={`thinking-${i}`}
				thinking={item.thinking}
				ref={item.thinkingRef}
				sessionId={sessionId}
			/>
		) : null,
		...item.tools.map((tool) => <ToolCallCard key={tool.key} tool={tool} />),
	]);

	// 单条已结束（如正文前的思考）直接裸行展示，不套 "已完成 · 1" 外壳
	const showWrapper = count >= 2 || shownWorking || subagentCount > 0;
	if (!showWrapper) {
		return <div className="-mb-4 flex flex-col gap-1.5">{rows}</div>;
	}

	return (
		<div className="-mb-4">
			<details
				className="group/outer peer drawer-details"
				onToggle={(e) => {
					if (e.currentTarget.open) setOpenedOnce(true);
				}}
			>
				<summary className="group/row flex cursor-pointer select-none flex-col [&::-webkit-details-marker]:hidden">
					<div className="flex min-h-6 w-full items-center gap-2 py-0.5">
						{shownWorking ? (
							<span className="shrink-0 text-[14px] font-bold text-ink-working transition-colors group-hover/row:text-ink">
								{t("message.working")}
							</span>
						) : segments.length > 0 ? (
							<span className="min-w-0 flex-1 truncate text-[13px] text-ink-dim transition-colors group-hover/row:text-ink">
								{segments.map((seg, i) => (
									<Fragment key={seg.key}>
										{i > 0 && <span className="opacity-50"> · </span>}
										{summaryLabel(t, seg)}
									</Fragment>
								))}
							</span>
						) : (
							<span className="text-[14px] font-bold text-ink-dim transition-colors group-hover/row:text-ink">
								{t("message.worked")}
							</span>
						)}
					</div>
					{dots.length > 0 && (
						<div className="mb-1 flex flex-wrap items-center gap-[3px] group-open/outer:hidden">
							{dots.map((dot) => (
								<span key={dot.key} className={dotClass(dot.state)} />
							))}
						</div>
					)}
				</summary>
				<div className="flex flex-col gap-1.5 py-1">{openedOnce ? rows : null}</div>
			</details>
		</div>
	);
}, metaGroupPropsEqual);
