"use client";
/**
 * components/percho/MessageList.tsx —— 中央消息流：最大宽度 760px 居中 + RO 底部跟随。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/MessageList.tsx
 * 适配：
 * - activeSessionId 由调用方传入（不依赖 percho sessions store）。
 * - 滚动容器外置：由 ChatWindow 传入 scrollContainerRef 作为唯一滚动源，原生滚动条出现在
 *   消息区最右缘（用户要求）；本组件只负责内容 + 底部跟随/回底按钮。
 * - 历史窗口化：首屏只渲染最近 N 行（与旧版 ChatWindow 一致），顶部哨兵可见时再往前翻页，
 *   翻页时按「距底距离」还原滚动位置，避免视口跳动。长会话（数百条）打开不再卡主线程。
 * - 对话区时间节点：每条用户气泡显示发送时刻，每轮末行显示「完成时刻 · 用时」，
 *   agent 仍在跑时底部挂一条每秒跳动的「当前时刻 · 进行中」。
 */
import { buildChatRows, deriveTurnChanges, computeTurnTimings, mapTurnTimingsToRows } from "@/lib/percho";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type MouseEvent,
	type RefObject,
} from "react";
import { selectTranscript, useTranscriptStore } from "@/lib/percho-store";
import {
	captureScrollDistance,
	getNextVisibleCount,
	getVisibleRenderWindow,
	restoreScrollTop,
} from "@/lib/chat-lazy-load";
import { MessageItem } from "./MessageItem";
import { MetaGroup } from "./MetaGroup";
import { RetryNote } from "./RetryNote";
import { SubagentRunCard } from "./SubagentRunCard";
import { TurnDiffChip } from "./TurnDiffChip";
import { LiveTurnLabel, TurnEndLabel } from "./TurnTiming";
import { useI18n } from "@/hooks/useI18n";

const BOTTOM_THRESHOLD = 48;
/** 历史窗口：每次翻页渲染的行数（一轮通常 2~4 行，40 行≈十几轮） */
const ROW_PAGE_SIZE = 40;

/** buildChatRows 的 timestamp：模块加载时固定（purity 规则禁止 render 内调 Date.now） */
const BUILD_ROWS_NOW = Date.now();

export function MessageList({
	sessionId,
	isDark,
	onOpenSubagent,
	scrollContainerRef,
	cwd,
	onOpenFile,
	onOpenWebUrl,
	following,
	onFollowingChange,
	fullWidth = false,
	revealAllNonce = 0,
}: {
	sessionId: string;
	isDark?: boolean;
	onOpenSubagent?: (sessionFile: string) => void;
	/** 外置滚动容器（消息区全宽，滚动条呈现在最右缘） */
	scrollContainerRef: RefObject<HTMLDivElement | null>;
	/** Notion 式全宽：去掉 760px 内容列宽限制（左右留 64px 安全边距，避开右缘目录条） */
	fullWidth?: boolean;
	cwd?: string;
	onOpenFile?: (filePath: string) => void;
	onOpenWebUrl?: (url: string) => void;
	/** 是否跟随底部（受控来自 ChatWindow，用于右侧常驻按钮） */
	following: boolean;
	onFollowingChange?: (value: boolean) => void;
	/** 变化时展开全部历史行（内容搜索/目录跳转到未渲染的消息前先调用） */
	revealAllNonce?: number;
}) {
	const { t } = useI18n();
	const transcript = useTranscriptStore((s) => selectTranscript(s, sessionId));

	const contentRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);
	const followingRef = useRef(following);
	const lastScrollTopRef = useRef(0);
	const lastScrollHeightRef = useRef(0);
	const [visibleRows, setVisibleRows] = useState(ROW_PAGE_SIZE);
	const savedScrollDistanceRef = useRef<number | null>(null);

	const updateFollowing = useCallback(
		(value: boolean) => {
			followingRef.current = value;
			onFollowingChange?.(value);
		},
		[onFollowingChange],
	);

	// 受控 following 变化时同步 ref（点击 ChatWindow 回底按钮直接置 true）
	useEffect(() => {
		followingRef.current = following;
	}, [following]);

	// 切会话回到首屏窗口
	useEffect(() => {
		setVisibleRows(ROW_PAGE_SIZE);
		savedScrollDistanceRef.current = null;
	}, [sessionId]);

	// 跳转（内容搜索 / 右侧目录）前先展开全部行，否则目标行还没挂载、滚不过去
	useEffect(() => {
		if (revealAllNonce > 0) setVisibleRows(Number.MAX_SAFE_INTEGER);
	}, [revealAllNonce]);

	const pinToBottom = useCallback(
		(behavior: ScrollBehavior = "auto") => {
			const el = scrollContainerRef.current;
			if (el) el.scrollTo({ top: el.scrollHeight, behavior });
		},
		[scrollContainerRef],
	);

	useEffect(() => {
		const scroll = scrollContainerRef.current;
		const content = contentRef.current;
		if (!scroll || !content) return;
		const observer = new ResizeObserver(() => {
			if (followingRef.current) pinToBottom();
		});
		observer.observe(content);
		observer.observe(scroll);
		return () => observer.disconnect();
	}, [pinToBottom, scrollContainerRef]);

	const lastMessage = transcript.messages[transcript.messages.length - 1];
	const lastUserMessageId = lastMessage?.kind === "user" ? lastMessage.id : null;
	useEffect(() => {
		if (!lastUserMessageId) return;
		updateFollowing(true);
		pinToBottom();
	}, [lastUserMessageId, pinToBottom, updateFollowing]);

	useEffect(() => {
		updateFollowing(true);
		pinToBottom();
	}, [sessionId, pinToBottom, updateFollowing]);

	const handleScroll = useCallback(() => {
		const el = scrollContainerRef.current;
		if (!el) return;
		const heightShrank = el.scrollHeight < lastScrollHeightRef.current;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
		if (atBottom) updateFollowing(true);
		else if (el.scrollTop < lastScrollTopRef.current && !heightShrank) updateFollowing(false);
		lastScrollTopRef.current = el.scrollTop;
		lastScrollHeightRef.current = el.scrollHeight;
	}, [scrollContainerRef, updateFollowing]);

	// 滚动监听挂在外置容器上（onScroll prop 无法跨组件挂到 ChatWindow 渲染的元素）
	useEffect(() => {
		const el = scrollContainerRef.current;
		if (!el) return;
		el.addEventListener("scroll", handleScroll, { passive: true });
		return () => el.removeEventListener("scroll", handleScroll);
	}, [handleScroll, scrollContainerRef]);

	const handleSummaryToggle = (e: MouseEvent) => {
		if (e.target instanceof Element && e.target.closest("summary")) updateFollowing(false);
	};

	const turnChanges = useMemo(() => deriveTurnChanges(transcript.messages), [transcript.messages]);
	const turnBaselineRef = useRef({ sid: sessionId, count: 0 });
	if (turnBaselineRef.current.sid !== sessionId) {
		turnBaselineRef.current = { sid: sessionId, count: turnChanges.length };
	}
	const enteringTurn =
		turnChanges.length > turnBaselineRef.current.count
			? turnChanges[turnChanges.length - 1]?.turnIndex
			: null;

	const rows = useMemo(
		() => buildChatRows(transcript, sessionId, BUILD_ROWS_NOW, { turnChanges, enteringTurn }),
		[transcript, sessionId, turnChanges, enteringTurn],
	);

	// 对话区时间节点：每轮发送/完成时刻 + 用时（纯函数，仅随 messages/rows 变化重算）
	const rowLabels = useMemo(() => {
		const turns = computeTurnTimings(transcript.messages);
		return mapTurnTimingsToRows(rows, turns, transcript.agentActive);
	}, [transcript.messages, transcript.agentActive, rows]);

	// --- 历史窗口化：顶部哨兵可见 → 往前翻页，翻页后还原滚动位置 ---
	useEffect(() => {
		const sentinel = sentinelRef.current;
		const container = scrollContainerRef.current;
		if (!sentinel || !container) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries[0]?.isIntersecting) return;
				savedScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
				setVisibleRows((prev) => getNextVisibleCount(prev, ROW_PAGE_SIZE));
			},
			{ root: container, threshold: 0 },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [visibleRows, rows.length, scrollContainerRef]);

	useLayoutEffect(() => {
		if (savedScrollDistanceRef.current == null) return;
		const container = scrollContainerRef.current;
		if (container) container.scrollTop = restoreScrollTop(container.scrollHeight, savedScrollDistanceRef.current);
		savedScrollDistanceRef.current = null;
	}, [visibleRows, scrollContainerRef]);

	const { startIndex, hasMore } = getVisibleRenderWindow(rows.length, visibleRows);

	const items: React.ReactNode[] = [];
	for (let rowIdx = startIndex; rowIdx < rows.length; rowIdx++) {
		const row = rows[rowIdx];
		const turnEnd = rowLabels.turnEndByRowIndex.get(rowIdx);
		if (row.kind === "turnDiff") {
			items.push(
				<div key={row.key} className={row.running || row.afterMetaGroup ? undefined : "-mt-4"}>
					<TurnDiffChip changes={row.changes} entering={row.entering} cwd={cwd} onOpenFile={onOpenFile} />
				</div>,
			);
			if (turnEnd) items.push(<TurnEndLabel key={`${row.key}-time`} ts={turnEnd.ts} durationMs={turnEnd.durationMs} />);
			continue;
		}
		if (row.kind === "metaGroup") {
			items.push(
				<MetaGroup
					key={row.key}
					items={row.items}
					working={row.working}
					endImmediately={row.endImmediately}
					subagentCount={row.subagentCount}
					sessionId={sessionId}
				/>,
			);
			if (turnEnd) items.push(<TurnEndLabel key={`${row.key}-time`} ts={turnEnd.ts} durationMs={turnEnd.durationMs} />);
			continue;
		}
		if (row.kind === "streamingSubagents") {
			items.push(<SubagentRunCard key={row.key} runs={row.runs} onOpen={onOpenSubagent} />);
			continue;
		}
		items.push(
			<MessageItem
				key={row.key}
				message={row.message}
				metaInGroup={row.metaInGroup}
				showActions={row.showActions}
				streaming={row.streaming}
				sessionId={sessionId}
				isDark={isDark}
				onOpenSubagent={onOpenSubagent}
				cwd={cwd}
				onOpenFile={onOpenFile}
				onOpenWebUrl={onOpenWebUrl}
			/>,
		);
		if (turnEnd) items.push(<TurnEndLabel key={`${row.key}-time`} ts={turnEnd.ts} durationMs={turnEnd.durationMs} />);
	}

	return (
		<div className="relative h-full" onClickCapture={handleSummaryToggle}>
			<div
				ref={contentRef}
				className={`mx-auto flex flex-col gap-6 pt-8 pb-16 ${
					fullWidth ? "w-full" : "max-w-[760px] px-6"
				}`}
			>
				{hasMore && (
					<div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
						{t("chat.loadEarlier", { count: startIndex })}
					</div>
				)}
				{items}
				{rowLabels.openTurn && <LiveTurnLabel startTs={rowLabels.openTurn.startTs} />}
				{transcript.retrying && <RetryNote info={transcript.retrying} />}
			</div>
		</div>
	);
}
