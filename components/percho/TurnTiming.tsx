"use client";
/**
 * components/percho/TurnTiming.tsx —— 对话区「时间节点」标签。
 *
 * 三个节点（用户要求：能一眼看出每轮耗时）：
 * - MessageClock：用户气泡上方的发送时刻
 * - TurnEndLabel：本轮最后一行下方的「完成时刻 · 用时」
 * - LiveTurnLabel：本轮仍在跑时的当前时刻 + 已进行时长（每秒跳动）
 *
 * 时间来源：user.timestamp（发送）与 endTimestamp（= 会话条目落盘时刻，完成）；
 * assistant 自带的 timestamp 是生成起点，不能当完成时间用。
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatElapsed, formatTurnDuration } from "@/lib/percho";

function two(n: number): string {
	return String(n).padStart(2, "0");
}

/** HH:mm:ss（24h，等宽数字） */
export function formatClock(ts: number): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

const CLOCK_CLASS =
	"shrink-0 font-mono text-[11px] leading-none tabular-nums text-ink-faint select-none";

export function MessageClock({ ts }: { ts?: number }) {
	if (!ts) return null;
	const clock = formatClock(ts);
	if (!clock) return null;
	return <div className={`mb-1 text-right ${CLOCK_CLASS}`}>{clock}</div>;
}

/** 本轮完成节点：完成时刻 · 用时 */
export function TurnEndLabel({ ts, durationMs }: { ts: number; durationMs: number | null }) {
	const { t } = useI18n();
	const clock = formatClock(ts);
	if (!clock) return null;
	return (
		<div className={`mt-1.5 flex items-center gap-1.5 ${CLOCK_CLASS}`}>
			<span>{clock}</span>
			{durationMs !== null && durationMs > 0 && (
				<>
					<span className="opacity-45">·</span>
					<span title={t("message.took", { duration: formatTurnDuration(durationMs) })}>
						{t("message.took", { duration: formatTurnDuration(durationMs) })}
					</span>
				</>
			)}
		</div>
	);
}

/**
 * 当前时间节点：agent 仍在跑时显示「此刻 · 本轮已进行 mm:ss」，1s 一跳。
 * 只在流式期间挂定时器，空闲时不产生任何重渲染。
 */
export function LiveTurnLabel({ startTs }: { startTs: number | null }) {
	const { t } = useI18n();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	const clock = formatClock(now);
	const elapsed = startTs !== null ? formatElapsed(now - startTs) : null;
	return (
		<div className={`mt-1.5 flex items-center gap-1.5 ${CLOCK_CLASS}`}>
			<span className="inline-flex h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-ink-faint" />
			<span>{clock}</span>
			{elapsed && (
				<>
					<span className="opacity-45">·</span>
					<span>{t("message.running", { elapsed })}</span>
				</>
			)}
		</div>
	);
}
