"use client";
/**
 * components/percho/SubagentRunCard.tsx —— 子代理运行卡（工作中/完成/失败 + 点击打开子会话）。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/SubagentRunCard.tsx
 * 适配：openFromHistory 由调用方传入（pi-web 用 useAgentSession 打开会话）。
 */
import { useI18n } from "@/hooks/useI18n";
import type { SubagentRunUi } from "@/lib/percho";

function displayName(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

function SubagentRunRow({ run, onOpen }: { run: SubagentRunUi; onOpen?: (sessionFile: string) => void }) {
	const { t } = useI18n();
	const clickable = run.sessionFile != null;
	const statusLabel =
		run.status === "running"
			? t("message.subagent.running")
			: run.status === "error"
				? t("message.subagent.failed")
				: t("message.subagent.done");

	return (
		<button
			type="button"
			disabled={!clickable}
			onClick={() => clickable && run.sessionFile && onOpen?.(run.sessionFile)}
			className={`flex w-full items-center gap-2 py-1 text-left ${
				clickable ? "cursor-pointer rounded-md hover:bg-hover" : "cursor-default"
			} px-1.5 transition-colors`}
		>
			{run.status === "running" ? (
				<span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
			) : run.status === "error" ? (
				<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
			) : (
				<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
			)}
			<span className="truncate text-[13px] font-semibold text-ink">{displayName(run.agent)}</span>
			<span className="shrink-0 text-[11px] text-ink-faint">{statusLabel}</span>
		</button>
	);
}

export function SubagentRunCard({ runs, onOpen }: { runs: SubagentRunUi[]; onOpen?: (sessionFile: string) => void }) {
	return (
		<div className="mt-1">
			{runs.map((run) => (
				<SubagentRunRow key={run.key} run={run} onOpen={onOpen} />
			))}
		</div>
	);
}
