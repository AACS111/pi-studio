import type { ChatRow } from "./chat-rows";
import type { UIMessage } from "./types";

/**
 * 轮次计时（对话区「时间节点」数据源）—— 纯函数，零 React/DOM。
 *
 * 一轮 = 一条 user 消息 + 其后直到下一条 user 之前的所有消息。
 * - startTs：用户发送时刻（user.timestamp）
 * - endTs：本轮最后一条消息的完成时刻（endTimestamp 优先，缺失回退 timestamp）
 * - durationMs：endTs - startTs
 *
 * endTimestamp 由后端在历史回放时补齐（= 会话条目落盘时刻）；assistant 自带的
 * timestamp 是「生成起点」，拿它当完成时间会把每轮耗时算成 0。
 */
export interface TurnTiming {
	/** 轮序号（从 0 起，按 user 消息切分；首条 user 之前的消息算第 0 轮） */
	index: number;
	startTs: number | null;
	endTs: number | null;
	durationMs: number | null;
}

function messageEndTs(message: UIMessage): number | null {
	const end = (message as { endTimestamp?: number }).endTimestamp;
	if (typeof end === "number" && Number.isFinite(end)) return end;
	const ts = (message as { timestamp?: number }).timestamp;
	return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

function messageStartTs(message: UIMessage): number | null {
	const ts = (message as { timestamp?: number }).timestamp;
	return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

export function computeTurnTimings(messages: UIMessage[]): TurnTiming[] {
	const turns: TurnTiming[] = [];
	let current: TurnTiming | null = null;
	for (const message of messages) {
		if (message.kind === "user") {
			const startTs = messageStartTs(message);
			current = { index: turns.length, startTs, endTs: startTs, durationMs: null };
			turns.push(current);
			continue;
		}
		// 首条 user 之前的消息（系统提示 / 压缩摘要）不单独成轮，也不计入任何轮次
		if (!current) continue;
		const end = messageEndTs(message);
		if (end === null) continue;
		if (current.endTs === null || end > current.endTs) current.endTs = end;
	}
	for (const turn of turns) {
		turn.durationMs =
			turn.startTs !== null && turn.endTs !== null && turn.endTs > turn.startTs
				? turn.endTs - turn.startTs
				: null;
	}
	return turns;
}

/**
 * 把轮次计时映射到渲染行：
 * - sentAtByRowIndex：该 user 行的发送时刻（气泡上方的小时钟）
 * - turnEndByRowIndex：该轮最后一行的完成时刻 + 用时（正文/折叠组下方的小字）
 *
 * 行序列与消息序列同序：user 行是轮边界，轮内最后一行（正文行或折叠组行）即计时落点。
 * 流式行（row.streaming）不落完成标签——本轮还没结束，由 LiveTurnLabel 负责。
 */
export interface RowTurnLabels {
	sentAtByRowIndex: Map<number, number>;
	turnEndByRowIndex: Map<number, { ts: number; durationMs: number | null }>;
	/** 最后一轮是否仍未定稿（agent 还在跑 / 本轮没有完成时刻） */
	openTurn: { startTs: number | null } | null;
}

export function mapTurnTimingsToRows(
	rows: ChatRow[],
	turns: TurnTiming[],
	agentActive: boolean,
): RowTurnLabels {
	const sentAtByRowIndex = new Map<number, number>();
	const turnEndByRowIndex = new Map<number, { ts: number; durationMs: number | null }>();
	let turnIdx = -1;
	let lastRowOfTurn = -1;

	const closeTurnAt = (rowIdx: number): void => {
		const turn = turns[turnIdx];
		if (!turn || rowIdx < 0) return;
		if (turn.endTs !== null && turn.startTs !== null && turn.endTs > turn.startTs) {
			turnEndByRowIndex.set(rowIdx, { ts: turn.endTs, durationMs: turn.durationMs });
		}
	};

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row.kind === "message" && row.message.kind === "user") {
			if (turnIdx >= 0) closeTurnAt(lastRowOfTurn);
			turnIdx += 1;
			lastRowOfTurn = i;
			const turn = turns[turnIdx];
			if (turn?.startTs != null) sentAtByRowIndex.set(i, turn.startTs);
			continue;
		}
		if (turnIdx < 0) continue; // 首条 user 之前的行不挂标签
		if (row.kind === "turnDiff") continue; // 文件变更 chip 不算轮末落点
		lastRowOfTurn = i;
	}

	const lastTurn = turns[turns.length - 1];
	// agent 还在跑：末轮不落完成标签，改由流式计时行显示「进行中」
	const stillOpen = agentActive;
	if (!stillOpen && turnIdx >= 0) closeTurnAt(lastRowOfTurn);

	return {
		sentAtByRowIndex,
		turnEndByRowIndex,
		openTurn: stillOpen && lastTurn ? { startTs: lastTurn.startTs } : null,
	};
}

/** 毫秒 → 人话时长：< 1s 显示 0.8s；< 60s 显示 12s；< 1h 显示 3m24s；否则 1h05m */
export function formatTurnDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** 毫秒 → 进行中秒数（mm:ss，用于流式计时） */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
