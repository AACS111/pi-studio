/**
 * lib/percho-store.ts —— percho transcript 大脑的 zustand 运行时桥接层。
 * 来源：percho packages/desktop/src/renderer/src/stores/{transcript,ui}.ts
 * 移植策略：只保留与生成状态无关的「纯前端状态 + 事件归约」，剔除 getPi() IPC 依赖
 * （sessions 打开/切换/fork/recall 等由 pi-web useAgentSession/rpc-manager 提供）。
 *
 * - useTranscriptStore：SSE 事件 → percho UIMessage[] 状态（还原 lib/percho 的 reduceEvent）
 * - usePerchoUiStore：todo 面板展开态、diff 侧栏开关（纯内存态）
 */
import type { PermissionRequest as SharedPermissionRequest, TodoItem } from "@/lib/percho";
import {
	type ActivityEntry,
	emptyTranscript,
	reduceEvent,
	type SessionEvent,
	type SessionPhase,
	type SessionTranscriptState,
	type StreamingState,
	type SubagentRunUi,
	type UIMessage,
	type UIToolCall,
} from "@/lib/percho";
import { create } from "zustand";

export type { ActivityEntry, SessionPhase, StreamingState, SubagentRunUi, UIMessage, UIToolCall };

/** 跨进程完整请求（含 kind/suggestDir）；pi-web 侧缺省字段适配在 adapter */
export type PermissionRequest = SharedPermissionRequest;

export interface SessionEntry extends SessionTranscriptState {
	pendingPermissions: PermissionRequest[];
}

const EMPTY_ENTRY: SessionEntry = { ...emptyTranscript(), pendingPermissions: [] };

/** 空 todo 列表稳定引用（面板 selector 缺省用，禁内联新数组） */
export const EMPTY_TODOS: TodoItem[] = [];

interface TranscriptStore {
	bySession: Record<string, SessionEntry>;
	/** isActiveViewing：事件到达时该会话是否正被查看，由调用方判定 */
	applyEvent: (sessionId: string, event: SessionEvent, opts?: { isActiveViewing?: boolean }) => void;
	/** 乐观置 agent 运行状态（发送消息后立即置 true，失败/结束后置 false 修正） */
	markAgentActive: (sessionId: string, active: boolean) => void;
	/** 清除完成未读标记 */
	markCompletionSeen: (sessionId: string) => void;
	addPermission: (sessionId: string, req: PermissionRequest) => void;
	resolvePermission: (sessionId: string, requestId: string) => void;
	resetSession: (sessionId: string) => void;
	/** 打开历史会话时回放已有消息（不触发 reducer 事件流） */
	loadHistory: (sessionId: string, messages: UIMessage[]) => void;
	/** 直接设置排队中的 followUp */
	setFollowUpQueue: (sessionId: string, queue: string[]) => void;
	/** 打开会话时从后端恢复任务列表（compaction 后 UI 面板数据源） */
	loadTodos: (sessionId: string, todos: TodoItem[]) => void;
}

export const useTranscriptStore = create<TranscriptStore>((set) => ({
	bySession: {},
	applyEvent: (sessionId, event, opts) => {
		set((state) => {
			const current = state.bySession[sessionId];
			const prev = current ?? emptyTranscript();
			const next = reduceEvent(prev, event);
			// 完成未读：agentActive true→false 且当时未被查看 → 置标记；重新开工 → 清除
			let unseenCompletion = prev.unseenCompletion;
			if (next.agentActive) unseenCompletion = false;
			else if (prev.agentActive && !opts?.isActiveViewing) unseenCompletion = true;
			return {
				bySession: {
					...state.bySession,
					[sessionId]: {
						...next,
						unseenCompletion,
						pendingPermissions: current?.pendingPermissions ?? [],
					},
				},
			};
		});
	},
	markAgentActive: (sessionId, active) => {
		set((state) => {
			const current = state.bySession[sessionId];
			if (!current) return state;
			return {
				bySession: {
					...state.bySession,
					[sessionId]: {
						...current,
						agentActive: active,
						unseenCompletion: active ? false : current.unseenCompletion,
					},
				},
			};
		});
	},
	markCompletionSeen: (sessionId) => {
		set((state) => {
			const current = state.bySession[sessionId];
			if (!current?.unseenCompletion) return state;
			return {
				bySession: {
					...state.bySession,
					[sessionId]: { ...current, unseenCompletion: false },
				},
			};
		});
	},
	addPermission: (sessionId, req) => {
		set((state) => {
			const current = state.bySession[sessionId];
			return {
				bySession: {
					...state.bySession,
					[sessionId]: {
						...(current ?? emptyTranscript()),
						pendingPermissions: [...(current?.pendingPermissions ?? []), req],
						phase: "awaiting_permission",
					},
				},
			};
		});
	},
	resolvePermission: (sessionId, requestId) => {
		set((state) => {
			const current = state.bySession[sessionId];
			if (!current) return state;
			return {
				bySession: {
					...state.bySession,
					[sessionId]: { ...current, pendingPermissions: current.pendingPermissions.filter((p) => p.id !== requestId) },
				},
			};
		});
	},
	resetSession: (sessionId) => {
		set((state) => ({
			bySession: { ...state.bySession, [sessionId]: { ...emptyTranscript(), pendingPermissions: [] } },
		}));
	},
	loadHistory: (sessionId, messages) => {
		set((state) => {
			const current = state.bySession[sessionId];
			const notices = current?.messages.filter((message) => message.kind === "system" && !message.compact) ?? [];
			return {
				bySession: {
					...state.bySession,
					[sessionId]: {
						messages: [...notices, ...messages],
						streaming: null,
						phase: "idle",
						agentActive: false,
						unseenCompletion: false,
						compacting: false,
						followUpQueue: current?.followUpQueue ?? [],
						todos: current?.todos ?? [],
						pendingLlmError: null,
						retrying: null,
						pendingPermissions: current?.pendingPermissions ?? [],
					},
				},
			};
		});
	},
	setFollowUpQueue: (sessionId, queue) => {
		set((state) => {
			const current = state.bySession[sessionId];
			return {
				bySession: {
					...state.bySession,
					[sessionId]: { ...(current ?? { ...EMPTY_ENTRY }), followUpQueue: queue },
				},
			};
		});
	},
	loadTodos: (sessionId, todos) => {
		set((state) => {
			const current = state.bySession[sessionId];
			return {
				bySession: {
					...state.bySession,
					[sessionId]: { ...(current ?? { ...EMPTY_ENTRY }), todos },
				},
			};
		});
	},
}));

/** 读取某会话的 transcript（不存在时返回共享空态，引用稳定避免重渲染循环） */
export function selectTranscript(state: TranscriptStore, sessionId: string | null): SessionEntry {
	if (!sessionId) return EMPTY_ENTRY;
	return state.bySession[sessionId] ?? EMPTY_ENTRY;
}

// ============================================================================
// percho ui store（todo 面板展开态 / diff 侧栏开关）——纯内存态，直接移植
// ============================================================================

export type PerchoAppView = "chat" | "projects";

export interface DiffFocus {
	sectionKey: string;
	nonce: number;
}

interface PerchoUiStore {
	view: PerchoAppView;
	setView: (view: PerchoAppView) => void;
	todoExpanded: Record<string, boolean>;
	toggleTodoExpanded: (sessionId: string) => void;
	diffSidebarOpen: boolean;
	setDiffSidebarOpen: (open: boolean) => void;
	toggleDiffSidebar: () => void;
	diffFocus: DiffFocus | null;
	setDiffFocus: (sectionKey: string) => void;
	clearDiffFocus: () => void;
}

export const usePerchoUiStore = create<PerchoUiStore>((set) => ({
	view: "chat",
	setView: (view) => set({ view }),
	todoExpanded: {},
	toggleTodoExpanded: (sessionId) =>
		set((state) => ({ todoExpanded: { ...state.todoExpanded, [sessionId]: !state.todoExpanded[sessionId] } })),
	diffSidebarOpen: false,
	setDiffSidebarOpen: (open) => set({ diffSidebarOpen: open }),
	toggleDiffSidebar: () => set((state) => ({ diffSidebarOpen: !state.diffSidebarOpen })),
	diffFocus: null,
	setDiffFocus: (sectionKey) =>
		set((state) => ({ diffFocus: { sectionKey, nonce: (state.diffFocus?.nonce ?? 0) + 1 } })),
	clearDiffFocus: () => set({ diffFocus: null }),
}));
