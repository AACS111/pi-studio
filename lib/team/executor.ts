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
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { startRpcSession } from "../rpc-manager.ts";
import { getTeamDir } from "./store.ts";
import { buildAgentSystemPrompt } from "./context.ts";
import { createTeamTools, createToolSink, consumeToolRequests } from "./tools.ts";
import { recommendedCompactionForWindow } from "../compaction-settings.ts";
import type { AgentExecution, ExecutionStats, TeamDef, TeamEventInput, TeamMessage, TeamTask } from "./types.ts";
import type { ExecutionResult } from "./engine.ts";

export const INITIAL_PROMPT =
  "\n\n请根据以上信息开始执行你的职责。完成工作后，如有需要交接的内容，使用 team_handoff 工具交接给下一个角色（strict 模式不适用则跳过）。";

export interface AgentExecutionRequest {
  team: TeamDef;
  runId: string;
  execution: AgentExecution;
  context: string;
  existingTasks: TeamTask[];
  /** 执行模式：solo=简单任务入口角色单干（可读改代码），orchestrated=多角色协作（leader 只派活） */
  mode?: "solo" | "orchestrated";
  /** 取消信号：收到 abort 应立即中止会话并提前返回（用户点击停止对话时由 runtime 下发） */
  signal?: AbortSignal;
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
    // 预算分摊：单角色超时不再独占整个 run 时长，按预期角色数均分，并给后续未启动角色留 25% 余量。
    // 避免前几个角色吃光预算导致 tester 一行没跑。
    const agentCount = Math.max(team.agents.length, 2);
    const perAgentMs = Math.floor(team.maxRunMinutes * 60_000 * 0.75 / Math.max(agentCount - 1, 1));
    const timeoutMs = agent.timeoutMs ?? perAgentMs;

    // trace 文件：记录本角色完整思考流水/工具调用，供下游角色按需 read
    const traceDir = join(getTeamDir(team.sessionId), "runs", runId, "traces");
    mkdirSync(traceDir, { recursive: true });
    const traceFile = join(traceDir, `${execution.id}.md`);
    const writeTrace = (line: string) => {
      try { appendFileSync(traceFile, line + "\n"); } catch { /* trace 写入失败不阻断执行 */ }
    };
    writeTrace(`# 执行流水：${agent.name}（${execution.id}）\n\n任务：${request.context.slice(0, 200)}\n\n---\n`);

    // 编排模式下入口角色（leader）只做拆任务+派活+总结，禁止读改业务代码：
    //   工具白名单只保留 ls/find（只看结构不读内容），去掉 read/grep/bash/edit/write。
    //   filter 后为空则传空数组（=禁用所有内置工具，只靠 customTools：建任务/交接/记决策）。
    //   solo 模式：入口角色要“亲自干活”完成整个任务，必须给全套工具（覆盖 leader 默认的 ls/find）。
    //   ——此前实现只用了 agent.toolNames（leader 默认只剩 ls/find），导致 solo 路径无法真正改代码。
    const isOrchestrationEntry = request.mode === "orchestrated" && team.entryAgentId === agent.id;
    const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
    const effectiveToolNames = isOrchestrationEntry
      ? agent.toolNames.filter((n) => n === "ls" || n === "find")
      : request.mode === "solo" && team.entryAgentId === agent.id
        ? FULL_TOOLS
        : agent.toolNames;

    const { session } = await startRpcSession(execution.id, sessionFile, team.cwd, {
      toolNames: effectiveToolNames,
      ...(model && model.provider ? { initialModel: { provider: model.provider, modelId: model.modelId } } : {}),
      ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
      customTools: tools,
      // 团队角色会话上下文随 run 递增：显式启用压缩并按角色模型窗口给推荐阈值
      compaction: { enabled: true },
    });

    // 实时进度节流状态（try 外声明，finally 可安全清理）
    let thinkingBuf = "";
    let thinkingTimer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    const flushThinking = () => {
      if (!thinkingBuf.trim()) return;
      const chunk = thinkingBuf;
      thinkingBuf = "";
      request.onEvent({ type: "agent_progress", executionId: execution.id, agentId: agent.id, kind: "thinking", content: chunk });
    };

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

      // —— 实时进度转发：订阅底层 pi 会话事件，把 thinking/工具调用转为 agent_progress 团队事件 ——
      //   必须在 prompt 前订阅，全程实时流式：thinking_delta 每 ~250ms 合并一条，工具调用实时转发。
      //   （此前订阅排在 prompt 之后，整个执行期间收不到进度 → 前端只显示「正在执行」而看不到思考/工具过程）
      //   同时：①trace 同步落盘 ②maxTurns 回合上限 steer 收尾
      let toolCallCount = 0;
      const maxTurns = agent.maxTurns ?? 20;
      let turnLimitSteered = false;
      unsubscribe = session.onEvent((ev) => {
        try {
          const et = ev as { type: string };
          if (et.type === "message_update") {
            const ue = ev as {
              type: string;
              assistantMessageEvent?: { type: string; delta?: string; content?: string };
            };
            const am = ue.assistantMessageEvent;
            if (am?.type === "thinking_delta" && am.delta) {
              thinkingBuf += am.delta;
              writeTrace(`[thinking] ${am.delta}`);
              if (!thinkingTimer) {
                thinkingTimer = setInterval(flushThinking, 250);
              }
            } else if (am?.type === "thinking_end" && am.content) {
              thinkingBuf = am.content;
              writeTrace(`\n[thinking-end] ${am.content}\n`);
              if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = undefined; }
              flushThinking();
            }
          } else if (et.type === "tool_execution_start") {
            const te = ev as { toolName?: string; args?: unknown };
            const summary = summarizeToolCall(te.toolName ?? "", te.args);
            request.onEvent({ type: "agent_progress", executionId: execution.id, agentId: agent.id, kind: "tool", content: summary });
            writeTrace(`[tool] ${summary}`);
            toolCallCount++;
            if (toolCallCount >= maxTurns && !turnLimitSteered) {
              turnLimitSteered = true;
              const steerMsg = `已达到回合上限（${maxTurns}次工具调用）。请立即收尾：总结当前进度与产物，用 team_handoff 交接给下一个角色（或 __end__ 若任务已全部完成）。不要再次调用读写工具。`;
              writeTrace(`\n[maxTurns] 达到上限，steer 收尾\n`);
              void session.send({ type: "steer", text: steerMsg } as never).catch(() => {
                abortExecution();
              });
            }
          }
        } catch {
          /* 进度转发失败不影响执行 */
        }
      });

      // —— 执行回合：首条消息 = 角色 systemPrompt + 共享上下文 + 任务指令 ——
      //   支持外部取消：runtime.cancel() 时 abortController.abort() → 立即 abort 会话并让 prompt 提前返回。
      let removeAbortListener: (() => void) | undefined;
      let promptAborted = false;
      const abortExecution = () => {
        if (promptAborted) return;
        promptAborted = true;
        void session.send({ type: "abort" }).catch(() => undefined);
      };
      if (request.signal) {
        if (request.signal.aborted) abortExecution();
        else {
          request.signal.addEventListener("abort", abortExecution, { once: true });
          removeAbortListener = () => request.signal?.removeEventListener("abort", abortExecution);
        }
      }

      const promptPromise = session.inner.prompt(
        `${buildAgentSystemPrompt(agent, context, request.mode)}${INITIAL_PROMPT}`,
        { source: "rpc" },
      );
      // 外部取消抢先 reject：使 withTimeout 内的 prompt 提前返回，回合立即结束
      const watchable = request.signal
        ? Promise.race([
            promptPromise,
            new Promise<never>((_, reject) => {
              const onCancel = () => {
                abortExecution();
                reject(new Error("用户取消执行"));
              };
              if (request.signal!.aborted) onCancel();
              else request.signal!.addEventListener("abort", onCancel, { once: true });
            }),
          ])
        : promptPromise;

      await withTimeout(
        watchable,
        timeoutMs,
        async () => {
          await session.send({ type: "abort" }).catch(() => undefined);
        },
        request.signal
          ? () => {
              abortExecution();
              removeAbortListener?.();
            }
          : undefined,
      );
      removeAbortListener?.();
      // 实时进度订阅已在 prompt 前建立（见上方），此处不再重复。

      // 采集回合统计（token/成本/消息数）
      let stats: ExecutionStats | undefined;
      try {
        const raw = (await session.send({ type: "get_session_stats" })) as {
          tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
          cost?: number;
          userMessages?: number;
          assistantMessages?: number;
          toolCalls?: number;
          toolResults?: number;
          totalMessages?: number;
          sessionFile?: string;
        } | null;
        if (raw) {
          stats = {
            inputTokens: raw.tokens?.input ?? 0,
            outputTokens: raw.tokens?.output ?? 0,
            cacheReadTokens: raw.tokens?.cacheRead ?? 0,
            cacheWriteTokens: raw.tokens?.cacheWrite ?? 0,
            totalTokens: raw.tokens?.total ?? 0,
            cost: raw.cost ?? 0,
            userMessages: raw.userMessages ?? 0,
            assistantMessages: raw.assistantMessages ?? 0,
            toolCalls: raw.toolCalls ?? 0,
            toolResults: raw.toolResults ?? 0,
            totalMessages: raw.totalMessages ?? 0,
          };
        }
      } catch {
        stats = undefined;
      }

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
      } finally {
        if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = undefined; }
        flushThinking();
        unsubscribe();
      }

      // 消费受控工具请求 → 事件（task/artifact/decision）；handoff 留给路由
      const { handoff, lastVerdict } = consumeToolRequests(sink, execution.id, agent.id, runId, (e) =>
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
        // P1-1：只有 pass/fail 才作为路由信号，info 不算
        ...(lastVerdict === "pass" || lastVerdict === "fail" ? { verdict: lastVerdict } : {}),
        ...(stats ? { stats } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "failed", output: "", failureReason: message };
    } finally {
      if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = undefined; }
      try { flushThinking(); } catch { /* 尽力 */ }
      try { unsubscribe?.(); } catch { /* 尽力 */ }
      try {
        await session.shutdown();
      } catch {
        /* 尽力清理 */
      }
    }
  }
}

/** 带超时的执行（超时 abort 后判定 failed/timeout）。
 *  onExternalAbort：外部取消（用户停止）时执行——用于清理 abort 监听等。
 *  prompt promise 自身已通过 Promise.race 对 abort 提前 reject，此处 timeout 仅兜底。 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Promise<void>,
  onExternalAbort?: () => void,
): Promise<T> {
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
    onExternalAbort?.();
  }
}

/** 把工具调用转为简短、对用户友好的进度描述（agent_progress 的 tool 内容） */
function summarizeToolCall(toolName: string, args: unknown): string {
  try {
    const a = (typeof args === "string" ? JSON.parse(args) : args ?? {}) as Record<string, unknown>;
    switch (toolName) {
      case "read":
        return `📖 读取 ${fmtPath(a.path)}`;
      case "bash":
        return `⌨️ 执行 ${fmtCmd(a.command)}`;
      case "grep":
      case "rg":
        return `🔍 搜索 ${fmtQuery(a.query ?? a.pattern)}`;
      case "write":
        return `✍️ 写入 ${fmtPath(a.path)}`;
      case "edit":
        return `🛠️ 编辑 ${fmtPath(a.path)}`;
      case "team_handoff":
        return `🤝 交接给「${String(a.to ?? "")}」`;
      case "team_create_task":
        return `📋 建任务「${String(a.title ?? "")}」`;
      case "team_complete_task":
        return `✅ 完成任务`;
      case "team_record_decision":
        return `📌 记录决策`;
      default:
        return `🔧 ${toolName}`;
    }
  } catch {
    return `🔧 ${toolName}`;
  }
}

function fmtPath(v: unknown): string {
  const s = String(v ?? "");
  return s.length > 48 ? `…${s.slice(-45)}` : s || "(未指定)";
}

function fmtCmd(v: unknown): string {
  const s = String(v ?? "").replace(/\s+/g, " ");
  return s.length > 56 ? `${s.slice(0, 53)}…` : s || "(空)";
}

function fmtQuery(v: unknown): string {
  const s = String(v ?? "").replace(/\s+/g, " ");
  return s.length > 40 ? `${s.slice(0, 37)}…` : s || "(空)";
}
