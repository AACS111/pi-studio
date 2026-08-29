/**
 * lib/percho-bridge.ts —— pi-web SSE 事件 → percho transcript store 的桥接。
 * 在 useAgentSession.handleAgentEvent 内被调用（最小侵入），把每个 SDK 事件喂给
 * lib/percho-store 的 reduceEvent，使 percho 呈现层（TodoPanel / MessageList / 错误卡）
 * 拿到与 pi-web 旧 UI 同一份实时数据。
 *
 * 注意：这层只做「转发」，不改变 pi-web 自身的状态管理。isActiveViewing 由调用方传。
 */
import { useTranscriptStore } from "@/lib/percho-store";
import type { SessionEvent } from "@/lib/percho";
import type { AgentEvent } from "@/lib/rpc-manager";

let lastActiveSessionId: string | null = null;

/** 记录当前被查看的会话（供 applyEvent 判定「完成未读」用），由 AppShell/ChatWindow 维护 */
export function setPerchoActiveSession(sessionId: string | null): void {
	lastActiveSessionId = sessionId;
}

/** 把单个 SSE 事件喂给 percho transcript store（isActiveViewing 按当前查看会话判定） */
export function bridgePerchoEvent(sessionId: string | null, event: AgentEvent): void {
	if (!sessionId) return;
	const isActiveViewing = sessionId === lastActiveSessionId;
	// AgentEvent 是宽松形状（{ type; [key]: unknown }），SessionEvent 是 pi 事件联合。
	// 运行时事件对象即为完整 SDK AgentSessionEvent（含 assistantMessageEvent 等），强转是安全的。
	useTranscriptStore
		.getState()
		.applyEvent(sessionId, event as unknown as SessionEvent, { isActiveViewing });
}
