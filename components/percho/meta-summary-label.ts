"use client";
/**
 * components/percho/meta-summary-label.ts —— 折叠组 worked 态分类汇总文案。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/meta-summary-label.ts
 */
import type { SummarySegment } from "@/lib/percho";
import type { TranslationParams } from "@/lib/i18n/types";
import { displayName } from "./ToolCallCard";

export type LabelT = (key: string, params?: TranslationParams) => string;

/** en 复数单位（zh 模板不含 {unit} 占位，参数传入即被忽略） */
const pluralUnit = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function summaryLabel(t: LabelT, seg: SummarySegment): string {
	switch (seg.category) {
		case "read":
			return t("message.summaryRead", { n: seg.count, unit: pluralUnit(seg.count, "file", "files") });
		case "edit":
			return t("message.summaryEdit", { n: seg.count, unit: pluralUnit(seg.count, "file", "files") });
		case "explore":
			return t("message.summaryExplore", { n: seg.count, unit: pluralUnit(seg.count, "time", "times") });
		case "search":
			return t("message.summarySearch", { n: seg.count, unit: pluralUnit(seg.count, "time", "times") });
		case "bash":
			return t("message.summaryBash", { n: seg.count, unit: pluralUnit(seg.count, "command", "commands") });
		case "subagent":
			return t("message.summarySubagents", {
				n: seg.count,
				unit: pluralUnit(seg.count, "subagent", "subagents"),
			});
		default:
			return `${displayName(seg.name)} ×${seg.count}`;
	}
}
