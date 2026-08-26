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
import { mkdirSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import { startRpcSession } from "../rpc-manager.ts";
import { isFilePathInsideCwd, type ChangedFile } from "../changed-files.ts";
import { getTeamDir } from "./store.ts";
import { buildRoleContextBlock } from "./context.ts";
import { createTeamTools, createToolSink, consumeToolRequests } from "./tools.ts";
import { recommendedCompactionForWindow } from "../compaction-settings.ts";
import type { AgentExecution, ExecutionStats, TeamDef, TeamEventInput, TeamMessage, TeamTask } from "./types.ts";
import type { ExecutionResult } from "./engine.ts";

export const INITIAL_PROMPT =
  "\n\n请根据以上信息开始执行你的职责。完成工作后，如有需要交接的内容，使用 team_handoff 工具交接给下一个角色（strict 模式不适用则跳过）。";

/** 构造首条 user message：显式包含用户原始任务 + 触发指令。
 *  必须把 task 放进 user message（而非只放 systemPrompt）——provider 的 prompt cache
 *  可能命中旧 systemPrompt 快照，导致追加在 systemPrompt 末尾的角色块/任务被 cache
 *  吞掉、LLM 实际收不到 task。user message 是 cache 的自然失效点，这里拼进去保证
 *  task 一定进入 LLM 输入。 */
function buildInitialPrompt(task: string): string {
  const t = (task ?? "").trim();
  if (!t) return INITIAL_PROMPT;
  return [
    "",
    "## 用户任务（本次必须完成的需求，唯一权威来源）",
    t,
    "",
    "请立即开始执行以上任务。完成后如需下游角色接力，使用 team_handoff 交接；若任务已全部由你完成，使用 team_handoff(to: \"__end__\") 结束。",
  ].join("\n");
}

export interface AgentExecutionRequest {
  team: TeamDef;
  runId: string;
  execution: AgentExecution;
  context: string;
  existingTasks: TeamTask[];
  /** 用户原始任务文本（run.task）。会显式拼进首条 user message，
   *  确保即使 systemPrompt 命中 provider 的 prompt cache、追加的角色块未生效，
   *  task 也一定进入 LLM 的实际输入，不会被 cache 吞掉。 */
  task: string;
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

    // 独立 pi 会话文件（可回放/审计）：收敛为「每角色一份」。同一个角色的多次执行
    // （返工/重进）复用同一 <runId>-<agentId>.jsonl——SessionManager.open 对已存在文件走
    // 「加载续跑」分支，未存在则新建，从而既保留角色跨轮次上下文连续性，又只落一个 .jsonl。
    const sessionDir = join(getTeamDir(team.sessionId), "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, `${runId}-${execution.agentId}.jsonl`);

    // 受控工具
    const sink = createToolSink();
    const tools = createTeamTools({ team, executingAgentId: agent.id, existingTasks, sink });

    // 变更文件采集（edit/write）：跟普通会话一样把「改动的文件」显示出来。
    // 在 tool_execution_start 里按工具名 + 参数路径记录，仅保留站在项目 cwd 内的文件（排除临时脚本/导出）。
    const changedFiles = new Map<string, ChangedFile["kind"]>();

    const model = parseAgentModel(agent.model);
    // 预算分摊：单角色超时不再独占整个 run 时长，按预期角色数均分，并给后续未启动角色留 25% 余量。
    // 避免前几个角色吃光预算导致 tester 一行没跑。
    const agentCount = Math.max(team.agents.length, 2);
    const perAgentMs = Math.floor(team.maxRunMinutes * 60_000 * 0.75 / Math.max(agentCount - 1, 1));
    const timeoutMs = agent.timeoutMs ?? perAgentMs;

    // —— 每角色一份「总结」.md（替代旧的每执行一份「流水」.md）——
    //   路径：runs/<runId>/summaries/<agentId>.md。每次执行追加一段「执行 #seq」小节，一个角色只
    //   沉淀一个文件，作为交接/上下文里可读的「总结」。完整思考全文在对应会话 .jsonl 里
    //   （sessions/<runId>-<agentId>.jsonl），下游角色需要时自行 read，不用把思考流水塞进上下文。
    const summaryDir = join(getTeamDir(team.sessionId), "runs", runId, "summaries");
    mkdirSync(summaryDir, { recursive: true });
    const summaryFile = join(summaryDir, `${agent.id}.md`);
    const appendSummary = (block: string) => {
      try { appendFileSync(summaryFile, block + "\n"); } catch { /* 总结写入失败不阻断执行 */ }
    };
    // 生命周期日志：细粒度思考/工具流水已实时经 SSE 推送并写进会话 .jsonl，这里不再落文件
    // （保持总结 .md 精简，只含结论/交接等交接用内容）。
    const writeTrace = (line: string) => { void line; /* 思考流水不再落 .md，避免总结文件被撑大 */ };
    // 总结文件头只在首次执行时写一次（同一角色多次执行复用同一文件，避免头部重复）
    if (!existsSync(summaryFile)) {
      appendSummary(`# 角色总结：${agent.name}（${agent.id}）\n> 思考/会话全文：sessions/${runId}-${agent.id}.jsonl（下游角色按需 read）\n`);
    }

    // 编排模式下入口角色（leader）：允许读代码/写方案（用于需求分析、方案设计、判断难度、拆分任务），
    //   但禁用 edit/bash（不直接改业务代码）——既能让组长读懂现状判断工作难度，又能承担需求分析与方案设计（不再必须依赖 product）。
    //   filter 后为空则传空数组（=禁用所有内置工具，只靠 customTools：建任务/交接/记决策）。
    //   solo 模式：入口角色要“亲自干活”完成整个任务，必须给全套工具（覆盖 leader 默认的 ls/find）。
    //   ——此前实现只用了 agent.toolNames（leader 默认只剩 ls/find），导致 solo 路径无法真正改代码。
    const isOrchestrationEntry = request.mode === "orchestrated" && team.entryAgentId === agent.id;
    const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
    const ENTRY_ANALYSIS_TOOLS = ["read", "write", "grep", "find", "ls"];
    const effectiveToolNames = isOrchestrationEntry
      ? agent.toolNames.filter((n) => ENTRY_ANALYSIS_TOOLS.includes(n))
      : request.mode === "solo" && team.entryAgentId === agent.id
        ? FULL_TOOLS
        : agent.toolNames;

    // 项目组角色默认开启思维链：项目组任务通常需推理拆解，关闭会明显变蠢。
    // agent.thinkingLevel 显式指定时优先其值；否则默认 medium（跟随 pi 的档位语义）。
    const effectiveThinkingLevel = agent.thinkingLevel ?? "medium";

    // 项目组角色统一禁用个人记忆/待办类工具：memory_*（跨会话记忆）、scratchpad（待办清
    // 单）。这些工具承载的是本机历史会话的“自动检查/待办”类条目，与当前业务任务无关，
    // 角色一旦 memory_search 就易被历史日志劫持（把本次任务当成“再做一次自动检查”，
    // 无视 task 字段里的真实需求）。团队内部协作走 team_* 受控工具，不靠个人记忆。
    const TEAM_DENY_TOOLS = ["memory_list", "memory_search", "memory_save", "memory_forget", "memory_restore", "scratchpad"];

    const { session } = await startRpcSession(execution.id, sessionFile, team.cwd, {
      toolNames: effectiveToolNames,
      ...(model && model.provider ? { initialModel: { provider: model.provider, modelId: model.modelId } } : {}),
      ...(effectiveThinkingLevel ? { thinkingLevel: effectiveThinkingLevel } : {}),
      customTools: tools,
      denyToolNames: TEAM_DENY_TOOLS,
      // 团队角色会话上下文随 run 递增：显式启用压缩并按角色模型窗口给推荐阈值
      compaction: { enabled: true },
      // 注意：不在这里传 systemPrompt——传了会被 rpc-manager 整体覆盖掉 pi 默认提示词
      // （含模型身份、工具规范、AGENTS.md 项目指令），让角色变蠢。改在 waitUntilReady 后追加。
    });

    // 实时进度节流状态（try 外声明，finally 可安全清理）
    let thinkingBuf = "";
    let thinkingTimer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    // 本次执行实际生效的模型（agent.model 显式 / 跟随全局默认后由会话解析出的具体模型），供 UI 展示
    let actualModel: { provider: string; modelId: string } | undefined;
    const flushThinking = () => {
      if (!thinkingBuf.trim()) return;
      const chunk = thinkingBuf;
      thinkingBuf = "";
      request.onEvent({ type: "agent_progress", executionId: execution.id, agentId: agent.id, kind: "thinking", content: chunk });
    };

    try {
      // 会话就绪（等待扩展绑定/资源加载）可能真实挂起（如某个扩展的 session_start 一直不 resolve），
      // 若不限时会无限阻塞整个 run（用户反馈「卡死」的一类根因）。这里加启动超时兜底：
      // 超时即视为会话失败闭合（onTimeout 不阻塞 reject，尽力关闭底层会话），不再让 run 无限等待。
      // 同时把取消信号也纳入竞争：用户点停止时，即使卡在 waitUntilReady 也能立即中止（而不是死等 90s 超时）。
      await withTimeout(
        raceWithAbort(session.waitUntilReady(), request.signal, () => { void session.shutdown().catch(() => undefined); }),
        Math.min(timeoutMs, 90_000),
        async () => {
          void session.shutdown().catch(() => undefined);
        },
      );

      // 采集实际生效模型：无论 agent.model 是否为空（跟随系统），会话都会解析出具体模型
      // （provider/modelId）。UI 层据此显示「每个角色用了什么模型」，跟随系统也能看到具体模型名。
      const im = (session.inner as unknown as { model?: { provider?: string; id?: string; contextWindow?: number } }).model;
      if (im?.provider && im?.id) actualModel = { provider: im.provider, modelId: im.id };
      writeTrace(`[model] 实际生效模型：${actualModel ? `${actualModel.provider}/${actualModel.modelId}` : "(未解析)"}`);
      // 立即实时推送「运行中使用的模型」：让前端运行中的角色块（不只是完成后消息头）也能看到具体模型名
      // （含「跟随系统」时解析出的具体模型）。放 prompt 前，运行一开始即可见。
      if (actualModel) {
        writeTrace(`[model] 实时推送：${actualModel.provider}/${actualModel.modelId}`);
        request.onEvent({
          type: "agent_progress",
          executionId: execution.id,
          agentId: agent.id,
          kind: "model",
          content: `${actualModel.provider}/${actualModel.modelId}`,
        });
      }

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

      // —— 追加项目组角色块到 pi 默认 systemPrompt 之后（不覆盖）——
      // pi 在 waitUntilReady/资源加载后已构建默认 systemPrompt（模型身份+工具规范+AGENTS.md/CLAUDE.md）。
      // 此处读出它，把「角色职责+团队上下文+项目指令/工作目录」叠加在后面写回，保留 pi 全部 agent 素养。
      const roleBlock = buildRoleContextBlock(agent, context, request.mode, team.cwd);
      const agentState = (session.inner as unknown as {
        agent?: { state?: { systemPrompt?: string } | null };
      }).agent?.state;
      if (agentState) {
        const basePrompt = (agentState.systemPrompt ?? "").trim();
        agentState.systemPrompt = basePrompt ? `${basePrompt}\n\n${roleBlock}` : roleBlock;
        writeTrace(`[systemPrompt] 已追加项目组角色块（base=${basePrompt.length}字节, role=${roleBlock.length}字节）`);
      }

      // —— 实时进度转发：订阅底层 pi 会话事件，把 thinking/工具调用转为 agent_progress 团队事件 ——
      //   必须在 prompt 前订阅，全程实时流式：thinking_delta 每 ~250ms 合并一条，工具调用实时转发。
      //   （此前订阅排在 prompt 之后，整个执行期间收不到进度 → 前端只显示「正在执行」而看不到思考/工具过程）
      //   同时：①trace 同步落盘 ②maxTurns 回合上限 steer 收尾
      let toolCallCount = 0;
      // 回合上限：默认 60（此前 20 对真实开发任务太紧——solo 场景一个角色要“读前端+读后端+改+验证”，
      //   探索阶段就会耗尽 20 次而被迫 steer 收尾，还没开始改就被掐断。60 给足探索+改造+验证的余量）。
      //   agent 显式配 maxTurns 时用其值，否则用默认 60。
      const maxTurns = agent.maxTurns ?? 60;
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
            const toolName = te.toolName ?? "";
            // 变更文件采集：edit → M，write/write_file/create/create_file → A
            const kind: ChangedFile["kind"] | null =
              toolName === "edit" ? "edit"
              : toolName === "write" || toolName === "write_file" || toolName === "create" || toolName === "create_file" ? "write"
              : null;
            if (kind) {
              try {
                const args = (typeof te.args === "string" ? JSON.parse(te.args) : (te.args ?? {})) as Record<string, unknown>;
                const p = String(args.path ?? args.filePath ?? "").trim().replace(/\\/g, "/");
                if (p && !changedFiles.has(p) && isFilePathInsideCwd(p, team.cwd)) changedFiles.set(p, kind);
              } catch { /* 路径解析失败忽略 */ }
            }
            const summary = summarizeToolCall(toolName, te.args);
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

      // 角色职责+团队上下文+项目指令已在上文追加进 systemPrompt。
      // 但 provider 的 prompt cache 可能命中旧 systemPrompt 快照、吞掉追加的角色块（含任务），
      // 所以这里把 task 显式放进首条 user message——user message 是 cache 失效点，保证任务一定进 LLM。
      // 取消信号：外部取消（用户停止）时 raceWithAbort 立即 reject（并发送底层 abort，尽力停止 LLM）。
      const promptPromise = session.inner.prompt(buildInitialPrompt(request.task), { source: "rpc" });
      const watchable = raceWithAbort(promptPromise, request.signal, abortExecution);

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

      // 产出群聊消息（兜底：角色最后一次 assistant 可能无文本（例：结尾是工具调用且模型未再产出
      //   text），导致 output 为空 → 下游角色消息缺失、群聊只剩入口角色。此时用交接摘要/改动文件
      //   兜底生成一条可见结论，让产品/开发/测试的产出与变更文件在群聊里可读，而非只靠 changedFiles 卡片。
      let messageContent = output.trim();
      const changedFileList = [...changedFiles].map(([filePath, kind]) => ({ filePath, kind }));
      if (!messageContent) {
        if (handoff?.summary) {
          messageContent = `交接：${handoff.summary.trim().slice(0, 800)}`;
        } else if (changedFileList.length) {
          messageContent = `已完成本次执行，改动 ${changedFileList.length} 个文件：${changedFileList
            .map((f) => f.filePath.split(/[\\/]/).pop())
            .join("、")}`;
        }
      } else if (changedFileList.length) {
        // 有正文结论时也补一行改动文件摘要，便于下游/用户一眼看到产物
        messageContent += `\n\n改动文件：${changedFileList
          .map((f) => f.filePath.split(/[\\/]/).pop())
          .join("、")}（共 ${changedFileList.length} 个）`;
      }
      if (messageContent.trim()) {
        onMessage({
          id: `msg-${execution.id}`,
          kind: "agent",
          executionId: execution.id,
          agentId: agent.id,
          role: agent.name,
          content: messageContent.trim(),
          createdAt: Date.now(),
        });
      }

      // 把本次执行结论沉淀到「每角色一份」的总结 .md（供交接/下游角色读取）
      try {
        appendSummary([
          `\n---\n## 执行 #${execution.sequence}`,
          `- 模型：${actualModel ? `${actualModel.provider}/${actualModel.modelId}` : "(未解析)"}`,
          `- 状态：完成`,
          `- 交接：${handoff ? `${handoff.to}${handoff.summary ? ` — ${handoff.summary.slice(0, 200)}` : ""}` : "（无）"}`,
          `- 结论：${(output.trim() || "（无输出）").slice(0, 800)}`,
        ].join("\n"));
      } catch { /* 总结写入失败不阻断 */ }

      return {
        status: "completed",
        output: output.trim(),
        ...(handoff ? { handoffTool: { to: handoff.to, summary: handoff.summary, artifacts: handoff.artifacts, blockers: handoff.blockers } } : {}),
        // P1-1：只有 pass/fail 才作为路由信号，info 不算
        ...(lastVerdict === "pass" || lastVerdict === "fail" ? { verdict: lastVerdict } : {}),
        ...(stats ? { stats } : {}),
        ...(actualModel ? { model: actualModel } : {}),
        ...(changedFiles.size ? { changedFiles: [...changedFiles].map(([filePath, kind]) => ({ filePath, kind })) } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        appendSummary(`\n---\n## 执行 #${execution.sequence}\n- 状态：失败\n- 原因：${message.slice(0, 300)}\n`);
      } catch { /* 总结写入失败不阻断 */ }
      return { status: "failed", output: "", failureReason: message, ...(actualModel ? { model: actualModel } : {}), ...(changedFiles.size ? { changedFiles: [...changedFiles].map(([filePath, kind]) => ({ filePath, kind })) } : {}) };
    } finally {
      if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = undefined; }
      try { flushThinking(); } catch { /* 尽力 */ }
      try { unsubscribe?.(); } catch { /* 尽力 */ }
      try {
        // 有界关闭：abort 后底层会话可能挂起，加 10s 上限，避免 run() 永远不 resolve
        await boundedShutdown(session, 10_000);
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

/** 把 promise 与取消信号竞争：信号中止时立即 reject（提前返回，不等底层 LLM/会话挂起），
 *  onAbort 用于发送底层 abort（尽力为之）。无 signal 时原样返回 promise。 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const onCancel = () => {
        try { onAbort(); } catch { /* 忽略 */ }
        reject(new Error("用户取消执行"));
      };
      if (signal.aborted) onCancel();
      else signal.addEventListener("abort", onCancel, { once: true });
    }),
  ]);
}

/** 有界关闭：给 session.shutdown() 设最短等待上限，避免 abort 后底层会话挂起拖住整个 run
 * （这是「点停止但 run 一直不结束」的一类根因：shutdown 卡住时 run() 永远不 resolve）。 */
async function boundedShutdown(session: { shutdown: () => Promise<unknown> }, ms: number): Promise<void> {
  await Promise.race([
    session.shutdown().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
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
