"use client";
/**
 * components/percho/StreamRateChip.tsx —— 流式输出速率指示（彩底药丸 + 数字）。
 *
 * percho 消息流（USE_PERCHO_MESSAGE_LIST=true）才是实际渲染路径，旧 MessageView 的
 * 头部行在这里不存在，所以速率单独做成一个 chip，挂在「此刻 · 进行中」那一行末尾。
 *
 * 快慢用**彩底药丸 + 反色字**表达：浅色主题下 11px 彩色小字要过 4.5:1 对比度，
 * 只能选到 #38650f 那种暗橄榄，实测读起来就是黑色（见 globals.css --rate-* 注释）。
 * 慢速再叠字重 700 —— 色相 + 底色 + 字重三通道，色弱场景不靠「只辨颜色」。
 *
 * `streaming=false`（工具执行中 / 本轮已结束）时**去掉药丸、定格数值转灰**：
 * 那时模型根本没在吐字，归零会误报成「慢」，挂个中性色状态也是自相矛盾。
 */
import { useI18n } from "@/hooks/useI18n";
import { RATE_TIER_VAR, rateTier, useStreamRate } from "@/lib/stream-rate";

export function StreamRateChip({ chars, streaming }: { chars: number; streaming: boolean }) {
	const { t } = useI18n();
	const rate = useStreamRate(streaming, chars);
	if (rate === null) return null;
	const tier = rateTier(rate);
	return (
		<span
			className="inline-flex shrink-0 items-center font-mono text-[11px] leading-none tabular-nums select-none"
			style={{
				padding: streaming ? "1px 6px" : 0,
				borderRadius: "var(--radius-pill)",
				background: streaming ? RATE_TIER_VAR[tier] : "transparent",
				color: streaming ? "var(--rate-on)" : "var(--rate-idle)",
				fontWeight: streaming && tier === "slow" ? 700 : 400,
			}}
			title={t("i18n.streamRate")}
		>
			{rate.toFixed(1)} t/s
		</span>
	);
}
