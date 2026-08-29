"use client";
/**
 * components/percho/MetaGroup.tsx —— 外层折叠组：聚合多条非正文消息的思考/工具。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/MetaGroup.tsx
 * 简化：去掉 ThinkingOrb 中央动画 / PreviewTicker 流光 / use-sweep-highlight 扫光 / Slot 插件槽，
 *     保留折叠组核心（working 标题 + 圆点行 + worked 分类汇总 + 展开区思考行/工具卡）。
 *     动画层后续接回（对应 percho 原版）。
 */
import { dotsFromItems, type MetaDot, type MetaItem, summarizeCategories } from "@/lib/percho";
import { Fragment, memo, useMemo } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ExpandArrowIcon } from "./icons";
import { summaryLabel } from "./meta-summary-label";
import { ToolCallCard } from "./ToolCallCard";
import { useShownWorking } from "./use-shown-working";

export type { MetaItem };

/** 思考过程行（内层折叠，与 tool call 行同风格） */
function ThinkingRow({ thinking }: { thinking: string }) {
	const { t } = useI18n();
	return (
		<details className="group/dets drawer-details">
			<summary className="group/row flex cursor-pointer items-center gap-2 py-0.5 select-none [&::-webkit-details-marker]:hidden">
				<span className="shrink-0 text-[13px] font-semibold text-ink-faint transition-colors group-hover/row:text-ink">
					{t("message.thinking")}
				</span>
				<ExpandArrowIcon className="shrink-0 text-ink-faint opacity-0 transition-[opacity,transform,color] group-hover/row:opacity-100 group-hover/row:text-ink-2 group-open/dets:rotate-90" />
			</summary>
			<div className="py-1 pl-4 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink-dim select-text">
				{thinking}
			</div>
		</details>
	);
}

/** 圆点样式：done = 实心 ink-dim，error = 琥珀红，running = 空心呼吸（globals.css meta-dot-running） */
function dotClass(state: MetaDot["state"]): string {
	const base = "h-1 w-1 shrink-0 rounded-full";
	if (state === "running") return `${base} meta-dot-running`;
	return state === "error" ? `${base} bg-red-500` : `${base} bg-ink-dim`;
}

function metaGroupPropsEqual(
	a: { items: MetaItem[]; working: boolean; endImmediately?: boolean; subagentCount?: number },
	b: { items: MetaItem[]; working: boolean; endImmediately?: boolean; subagentCount?: number },
): boolean {
	if (
		a.working !== b.working ||
		a.endImmediately !== b.endImmediately ||
		a.subagentCount !== b.subagentCount ||
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
}: {
	items: MetaItem[];
	working: boolean;
	endImmediately?: boolean;
	subagentCount?: number;
}) {
	const { t } = useI18n();
	const count = items.reduce((n, item) => n + (item.thinking ? 1 : 0) + item.tools.length, 0);
	const dots = useMemo(() => dotsFromItems(items), [items]);
	const segments = useMemo(() => summarizeCategories(items, subagentCount), [items, subagentCount]);

	const shownWorking = useShownWorking(working, endImmediately);

	const rows = items.flatMap((item, i) => [
		item.thinking ? <ThinkingRow key={`thinking-${i}`} thinking={item.thinking} /> : null,
		...item.tools.map((tool) => <ToolCallCard key={tool.key} tool={tool} />),
	]);

	// 单条已结束（如正文前的思考）直接裸行展示，不套 "已完成 · 1" 外壳
	const showWrapper = count >= 2 || shownWorking || subagentCount > 0;
	if (!showWrapper) {
		return <div className="-mb-4 flex flex-col gap-1.5">{rows}</div>;
	}

	return (
		<div className="-mb-4">
			<details className="group/outer peer drawer-details">
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
						<div className="mb-0.5 flex flex-wrap gap-1 py-0.5 group-open/outer:hidden">
							{dots.map((dot) => (
								<span key={dot.key} className={dotClass(dot.state)} />
							))}
						</div>
					)}
				</summary>
				<div className="flex flex-col gap-1.5 py-1">{rows}</div>
			</details>
		</div>
	);
}, metaGroupPropsEqual);
