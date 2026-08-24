/**
 * AgentExecutor（设计稿 v5 §7.4）：一个角色执行 = 一个 pi 会话。
 *
 * 通过 startRpcSession 启动独立 pi 会话：
 *  - 注入角色 systemPrompt（含共享上下文）→ systemPrompt 覆盖
 *  - 注入受控工具集（team_handoff 等）→ customTools
 *  - 首条 prompt 触发执行；prompt resolve = 一次完整回合完成
 *  - 执行结束收集：最终输出文本 + 工具 sink（handoff 等请求）
 *
 * AgentExecutorLike 抽象：E2E 测试可注入 mock 执行器（不真实调 LLM）。
 */
import { mkdirSync } from "fs";
import { join } from "path";
import { startRpcSession } from "../rpc-manager.ts";
import { getTeamDir } from "./store.ts";
import { buildAgentSystemPrompt } from "./context.ts";
import { createTeamTools, createToolSink, consumeToolRequests } from "./tools.ts";
import { recommendedCompactionForWindow } from "../compaction-settings.ts";
import type { AgentExecution, TeamDef, TeamEventInput, TeamMessage, TeamTask } from "./types.ts";
import type { ExecutionResult } from "./engine.ts";

export const INITIAL_PROMPT =
  "\n\n请根据以上信息开始执行你的职责。完成工作后，如有需要交接的内容，使用 team_handoff 工具交接给下一个角色（strict 模式不适用则跳过）。";

export interface AgentExecutionRequest {
  team: TeamDef;
  runId: string;
  execution: AgentExecution;
  context: string;
  existingTasks: TeamTask[];
  /** 事件回调（Runtime 提供，写 events.jsonl 由 Runtime 负责） */
  onEvent: (event: TeamEventInput) => void;
  onMessage: (message: TeamMessage) => void;
}

export interface AgentExecutorLike {
  run(request: AgentExecutionRequest): Promise<ExecutionResult>;
}

/** 解析 agent.model："provider/modelId" 或 "modelId"（空 → 跟随默认） */
export function parseAgentModel(model: string): { provider: string; modelId: string } | null {
  if (!model?.trim()) return null;
  const idx = model.indexOf("/");
  if (idx > 0) {
    return { provider: model.slice(0, idx), modelId: model.slice(idx + 1) };
  }
  return { provider: "", modelId: model.trim() };
}

/** 真实执行器：启动 pi 会话跑完整回合 */
export class PiAgentExecutor implements AgentExecutorLike {
  async run(request: AgentExecutionRequest): Promise<ExecutionResult> {
    const { team, runId, execution, context, existingTasks, onMessage } = request;
    const agent = team.agents.find((a) => a.id === execution.agentId);
    if (!agent) throw new Error(`Agent ${execution.agentId} not found in team`);

    // 独立 pi 会话文件（可回放/审计）
    const sessionDir = join(getTeamDir(team.sessionId), "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, `${runId}-${execution.agentId}-${execution.sequence}.jsonl`);

    // 受控工具
    const sink = createToolSink();
    const tools = createTeamTools({ team, executingAgentId: agent.id, existingTasks, sink });

    const model = parseAgentModel(agent.model);
    const timeoutMs = agent.timeoutMs ?? team.maxRunMinutes * 60_000;

    const { session } = await startRpcSession(execution.id, sessionFile, team.cwd, {
      toolNames: agent.toolNames,
      ...(model && model.provider ? { initialModel: { provider: model.provider, modelId: model.modelId } } : {}),
      ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
      customTools: tools,
      // 团队角色会话上下文随 run 递增：显式启用压缩并按角色模型窗口给推荐阈值
      compaction: { enabled: true },
    });

    try {
      await session.waitUntilReady();

      // 按实际模型窗口补推荐阈值（首次进入时 rpc-manager 已按全局写入；
      // 此处确保即使模型窗口与全局推荐不同，当前会话也能尽早压缩）
      const window = (session.inner as unknown as { model?: { contextWindow?: number } }).model?.contextWindow ?? 0;
      if (window > 0) {
        const rec = recommendedCompactionForWindow(window);
        try {
          await session.send({ type: "set_compaction", enabled: true, reserveTokens: rec.reserveTokens, keepRecentTokens: rec.keepRecentTokens }).catch(() => undefined);
        } catch {
          /* 设置失败不阻断执行 */
        }
      }

      // 执行回合：首条消息 = 角色 systemPrompt + 共享上下文 + 任务指令
      // （pi 的 _systemPromptOverride 是私有且会被 base prompt 刷新，首条消息注入最可靠）
      await withTimeout(
        session.inner.prompt(`${buildAgentSystemPrompt(agent, context)}${INITIAL_PROMPT}`, { source: "rpc" }),
        timeoutMs,
        async () => {
          await session.send({ type: "abort" }).catch(() => undefined);
        },
      );

      // 收集最终输出
      let output = "";
      try {
        const lastText = (await session.send({ type: "get_last_assistant_text" })) as
          | { text?: string }
          | string
          | null;
        output = typeof lastText === "string" ? lastText : lastText?.text ?? "";
      } catch {
        output = "";
      }

      // 消费受控工具请求 → 事件（task/artifact/decision）；handoff 留给路由
      const { handoff } = consumeToolRequests(sink, execution.id, agent.id, runId, (e) =>
        request.onEvent(e as TeamEventInput),
      );

      // 产出群聊消息
      if (output.trim()) {
        onMessage({
          id: `msg-${execution.id}`,
          kind: "agent",
          executionId: execution.id,
          agentId: agent.id,
          role: agent.name,
          content: output.trim(),
          createdAt: Date.now(),
        });
      }

      return {
        status: "completed",
        output: output.trim(),
        ...(handoff ? { handoffTool: { to: handoff.to, summary: handoff.summary, artifacts: handoff.artifacts, blockers: handoff.blockers } } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "failed", output: "", failureReason: message };
    } finally {
      try {
        await session.shutdown();
      } catch {
        /* 尽力清理 */
      }
    }
  }
}

/** 带超时的执行（超时 abort 后判定 failed/timeout） */
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Promise<void>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void onTimeout().then(() => reject(new Error(`执行超时（${Math.round(ms / 1000)}s）`)));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
