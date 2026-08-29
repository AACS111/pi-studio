"use client";
/**
 * components/percho/MessageList.tsx —— 中央消息流：最大宽度 760px 居中 + RO 底部跟随。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/MessageList.tsx
 * 适配：
 * - activeSessionId 由调用方传入（不依赖 percho sessions store）；CenterOrb 中央动画省去（后续接回）。
 * - 滚动容器外置：由 ChatWindow 传入 scrollContainerRef（消息区全宽容器）作为唯一滚动源，
 *   这样原生滚动条出现在消息区最右缘（用户要求）；本组件只负责内容 + 底部跟随/回底按钮。
 *   内容自然溢出根容器（根容器高度=视口高度），由外层滚动容器承接滚动。
 */
import { buildChatRows, deriveTurnChanges } from "@/lib/percho";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { selectTranscript, useTranscriptStore } from "@/lib/percho-store";
import { MessageItem } from "./MessageItem";
import { MetaGroup } from "./MetaGroup";
import { RetryNote } from "./RetryNote";
import { SubagentRunCard } from "./SubagentRunCard";
import { TurnDiffChip } from "./TurnDiffChip";

const BOTTOM_THRESHOLD = 48;

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
}: {
	sessionId: string;
	isDark?: boolean;
	onOpenSubagent?: (sessionFile: string) => void;
	/** 外置滚动容器（消息区全宽，滚动条呈现在最右缘） */
	scrollContainerRef: RefObject<HTMLDivElement | null>;
	cwd?: string;
	onOpenFile?: (filePath: string) => void;
	onOpenWebUrl?: (url: string) => void;
	/** 是否跟随底部（受控来自 ChatWindow，用于右侧常驻按钮） */
	following: boolean;
	onFollowingChange?: (value: boolean) => void;
}) {
	const transcript = useTranscriptStore((s) => selectTranscript(s, sessionId));

	const contentRef = useRef<HTMLDivElement>(null);
	const followingRef = useRef(following);
	const lastScrollTopRef = useRef(0);
	const lastScrollHeightRef = useRef(0);

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

	const items: React.ReactNode[] = [];
	rows.forEach((row) => {
		if (row.kind === "turnDiff") {
			items.push(
				<div key={row.key} className={row.running || row.afterMetaGroup ? undefined : "-mt-4"}>
					<TurnDiffChip changes={row.changes} entering={row.entering} cwd={cwd} onOpenFile={onOpenFile} />
				</div>,
			);
			return;
		}
		if (row.kind === "metaGroup") {
			items.push(
				<MetaGroup
					key={row.key}
					items={row.items}
					working={row.working}
					endImmediately={row.endImmediately}
					subagentCount={row.subagentCount}
				/>,
			);
			return;
		}
		if (row.kind === "streamingSubagents") {
			items.push(<SubagentRunCard key={row.key} runs={row.runs} onOpen={onOpenSubagent} />);
			return;
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
	});

	return (
		<div className="relative h-full" onClickCapture={handleSummaryToggle}>
			<div ref={contentRef} className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 pt-8 pb-16">
				{items}
				{transcript.retrying && <RetryNote info={transcript.retrying} />}
			</div>
		</div>
	);
}
