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
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { startRpcSession } from "../rpc-manager.ts";
import { isFilePathInsideCwd, type ChangedFile } from "../changed-files.ts";
import { getTeamDir } from "./store.ts";
import { buildRoleContextBlock } from "./context.ts";
import { createTeamTools, createToolSink, consumeToolRequests, createDocWriteTool, validatePlanSubmission } from "./tools.ts";
import { recommendedCompactionForWindow } from "../compaction-settings.ts";
import type { AgentDef, AgentExecution, ExecutionStats, PlanTask, TeamDef, TeamEventInput, TeamMessage, TeamTask } from "./types.ts";
import type { ExecutionResult } from "./engine.ts";

export const INITIAL_PROMPT =
  "\n\n请根据以上信息开始执行你的职责。完成工作后，如有需要交接的内容，使用 team_handoff 工具交接给下一个角色（strict 模式不适用则跳过）。";

/** 构造首条 user message：显式包含用户原始任务 + 触发指令。
 *  必须把 task 放进 user message（而非只放 systemPrompt）——provider 的 prompt cache
 *  可能命中旧 systemPrompt 快照，导致追加在 systemPrompt 末尾的角色块/任务被 cache
 *  吞掉、LLM 实际收不到 task。user message 是 cache 的自然失效点，这里拼进去保证
 *  task 一定进入 LLM 输入。
 *  planner 轮（DAG 编排）：替换触发指令为「用 team_submit_plan 提交计划」；planError 非空时附纠错信息。 */
function buildInitialPrompt(task: string, planError?: string): string {
  const t = (task ?? "").trim();
  if (!t) return INITIAL_PROMPT;
  if (planError !== undefined) {
    return [
      "",
      "## 用户任务（本次必须完成的需求，唯一权威来源）",
      t,
      "",
      planError
        ? `⚠️ 上一次计划提交被拒绝：${planError}\n请阅读上下文与团队角色，修正后立即重新调用 team_submit_plan 提交。`
        : "你是计划者（planner）：现在不要亲自执行任何工作，而是把这个任务拆解为可调度的任务计划，并调用 team_submit_plan 工具一次性提交。无依赖的任务会并行执行；expectedOutput 写清验收标准（改哪些文件/接口约定/验证方法）。",
    ].join("\n");
  }
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
  /** 计划轮（DAG 编排）：注入 team_submit_plan 工具并透出 result.plan。
   *  仅影响工具集与首条指令；不改变角色/写权限策略。 */
  planner?: boolean;
  /** 计划校验失败后的纠错提示（planner 重试轮）：拼进首条指令，让模型修正重提 */
  planError?: string;
  /** 本轮计划/波次实际参与的角色数（DAG 调度传入）：时间预算按它分摊而非全体团队，闲置角色不稀释 */
  participantCount?: number;
  /** 取消信号：收到 abort 应立即中止会话并提前返回（用户点击停止对话时由 runtime 下发） */
  signal?: AbortSignal;
  /** 事件回调（Runtime 提供，写 events.jsonl 由 Runtime 负责） */
  onEvent: (event: TeamEventInput) => void;
  onMessage: (message: TeamMessage) => void;
}

export interface AgentExecutorLike {
  run(request: AgentExecutionRequest): Promise<ExecutionResult>;
}

/** 读会话 .jsonl 最后一条 assistant 消息的 LLM 错误（stopReason=error/aborted / errorMessage）。
 *  背景：模型侧失败时 pi 会写入空（或仅 thinking）assistant + 错误标记，
 *  get_last_assistant_text 返回空——旧逻辑误标为 completed(空输出)，重试/调度拿到假信号
 *  （实锤 run 84c22d07：provider 403 三轮全空却都当成功；run 907d9c13：be-dev 网络中断
 *  stop=aborted 仅剩 thinking 块也被当成功→空交付物占坑）。返回 undefined 表示本回合正常。
 *  调用约定：仅在文本输出为空时调用（有真实文本的回合不判失败）。 */
export function readLastAssistantLlmError(sessionFile: string): string | undefined {
  try {
    const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let parsed: unknown;
      try { parsed = JSON.parse(lines[i]); } catch { continue; }
      // 兼容两种包裹：{type:'message',message:{...}} 或直接消息对象
      const wrapper = parsed as { message?: Record<string, unknown>; role?: string };
      const m = (wrapper.message ?? wrapper) as {
        role?: string;
        content?: unknown;
        stopReason?: string;
        errorMessage?: string;
      };
      if (m.role !== "assistant") continue;
      // 错误标记优先于内容判断：thinking 流水不算产出（run 907d9c13 实锤：aborted 只留 thinking）
      if ((m.stopReason === "aborted" || m.stopReason === "error") && m.errorMessage) {
        return String(m.errorMessage);
      }
      if (Array.isArray(m.content) && m.content.some((p: { type?: string }) => p?.type === "text")) {
        return undefined; // 最后一条 assistant 有真文本 → 正常
      }
      if (m.stopReason === "error") return String(m.errorMessage ?? "模型调用失败（stopReason=error）");
      return undefined; // 空/仅 thinking 但无错误标记：不当 LLM 故障
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 单次执行的时间预算计算（纯函数）：
 *  1) agent.timeoutMs 显式配置最优先——不同角色耗时天然不同，团队级精细控制的主手段；
 *  2) DAG 编排传 participantCount = 计划实际派活的角色数（闲置角色不再稀释预算）；
 *  3) 兑底按团队规模但封顶 4（典型 planner + ≤3 并行分支；旧公式除以全队人数，
 *     8 角色时人均 6.4min，深度思考模型还没进入写码就被拦腰切断）；
 *  始终保留 25% 余量给后续未启动的执行。 */
export function computeExecutionTimeoutMs(o: {
  maxRunMinutes: number;
  agentCount: number;
  participantCount?: number;
  explicitTimeoutMs?: number;
}): number {
  if (o.explicitTimeoutMs && o.explicitTimeoutMs > 0) return o.explicitTimeoutMs;
  // NaN 防御：旧/手写 team.json 缺 maxRunMinutes 时 undefined 参与运算得 NaN，
  // setTimeout(fn, NaN)≈立即触发 → 每次执行瞬间「超时」失败 → hybrid 兜底回入口 →
  // 以 CPU 速度无限循环刷盘。这里兑底默认 30 分钟（与 runtime 保险丝兑底一致）。
  const maxRunMinutes = Number.isFinite(o.maxRunMinutes) && o.maxRunMinutes > 0 ? o.maxRunMinutes : 30;
  const participants = Math.max(o.participantCount ?? Math.min(o.agentCount, 4), 2);
  return Math.floor(maxRunMinutes * 60_000 * 0.75 / (participants - 1));
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

/** 解析写权限策略：显式 writePolicy 优先；缺省推导 = toolNames 含 edit → all（开发类角色），否则 docs。
 *  背景（run bcfc16cd 实锤）：leader/product/tester 借通用 write 工具越权写业务代码，提示词约束无效，
 *  必须在工具层封禁。 */
export function resolveWritePolicy(agent: Pick<AgentDef, "writePolicy" | "toolNames">): "all" | "docs" | "none" {
  if (agent.writePolicy) return agent.writePolicy;
  return agent.toolNames.includes("edit") ? "all" : "docs";
}

/** 按写权限策略清理内置工具白名单：docs/none 剔除 edit 与原版 write（docs 会另行注入受控 .md 写工具）。 */
export function applyWritePolicyToToolNames(policy: "all" | "docs" | "none", names: string[]): string[] {
  if (policy === "all") return names;
  return names.filter((n) => n !== "edit" && n !== "write");
}

/** 假宣称检测：扫描结论文本里「动词 + 源码文件」的修改宣称，返回 basename 不在实际变更集内的宣称清单。
 *  仅匹配带写入动词的句子（中性提及/验证语句不误报）；比对维度是文件名（basename），实际已写过的自然排除。 */
export function detectPhantomClaims(text: string, actualBasenames: Set<string>): string[] {
  if (!text?.trim()) return [];
  const VERB_CJK = /(现在|接下来|准备|即将|马上)?[\u4e00-\u9fa5]{0,6}(写入|重写|覆写|修改|编辑|更新|创建|新建|改造)[ \t]*[\u4e00-\u9fa5]{0,10}[ \t]*[`'\"「『]?([\w.\-/\\]+?\.(?:java|vue|ts|tsx|js|jsx|mjs|cjs|xml|sql|json|kt|go|py))/g;
  const VERB_EN = /\b(?:wrote|rewrote|overwrote|modifi(?:ed|es|y)|updated|edited|created|implemented)\b[^.\n]{0,40}?([\w.\-/\\]+\.(?:java|vue|ts|tsx|js|jsx|mjs|cjs|xml|sql|json|kt|go|py))/gi;
  const claimed = new Map<string, string>();
  const add = (p: string) => {
    const base = p.split(/[\\/]/).pop() ?? p;
    if (!actualBasenames.has(base) && !claimed.has(base)) claimed.set(base, p);
  };
  // 排除“改动文件：/实际修改”等事实性清单行（那是系统追加的真实变更，不是宣称）
  const lines = text.split(/\n/).filter((l) => !/^\s*(改动文件|实际修改|变更文件)[:：]/.test(l));
  for (const line of lines) {
    for (const m of line.matchAll(VERB_CJK)) add(m[3]);
    for (const m of line.matchAll(VERB_EN)) add(m[1]);
  }
  return [...claimed.values()].slice(0, 4);
}

export interface FallbackMessageInput {
  output: string;
  handoffSummary?: string;
  changedFiles: Array<{ filePath: string; kind: string }>;
  truncated: boolean;
  turnsUsed: number;
  maxTurns: number;
  /** 无任何产出时的查看指引（如 runs/<id>/thinking/<agent>.md） */
  detailHint?: string;
}

/** 群聊消息构建（修 bcfc16cd 缺陷③的根因）：角色最后一轮可能既无文本、又无交接、又无文件变更
 *  （典型：26 次只读探索后被回合上限 steer 收尾）——旧逻辑三分支都落空 → 静默无消息，下游/用户看不到该角色干过什么。
 *  新逻辑保证非空；同时叠加：真实变更清单恒显示（压缩叙事造假空间）、假宣称警示、截断诚实标注。 */
export function buildFallbackGroupMessage(input: FallbackMessageInput): { content: string; phantomWarnings: string[] } {
  const files = input.changedFiles ?? [];
  const actualBasenames = new Set(files.map((f) => f.filePath.split(/[\\/]/).pop() ?? f.filePath));
  const base = input.output?.trim() ?? "";
  let content = base;
  if (!content && input.handoffSummary?.trim()) content = `交接：${input.handoffSummary.trim().slice(0, 800)}`;
  if (!content && files.length > 0) content = `已完成本次执行，实际改动 ${files.length} 个文件`; // 具体清单在末尾统一拼
  if (!content) {
    content = input.truncated
      ? `本轮未产出文本结论（工具调用达上限 ${input.maxTurns} 次，提前收尾；期间均为只读操作或未完成动作）`
      : "本轮未产出文本结论";
    if (input.detailHint) content += `，过程详情见 ${input.detailHint}`;
  }
  const phantomWarnings = base ? detectPhantomClaims(base, actualBasenames) : [];
  let msg = content;
  if (files.length > 0) {
    msg += `\n\n实际改动文件：${files.map((f) => `${f.kind === "edit" ? "M" : "A"} ${f.filePath.split(/[\\/]/).pop()}`).join("、")}（共 ${files.length} 个）`;
  }
  for (const w of phantomWarnings) {
    msg += `\n⚠️ 宣称核对：文中提及修改 ${w}，但本执行未见对应写入操作（以系统实际变更清单为准，谨防假汇报）`;
  }
  if (input.truncated) {
    msg += `\n⚠️ 本执行命中工具调用上限（${input.turnsUsed}/${input.maxTurns}），属提前收尾——最后声称的动作可能未真正完成，请下游注意核实。`;
  }
  return { content: msg.trim(), phantomWarnings };
}

/** 总结块状态行（截断诚实化）：不再硬编码「完成」。 */
export function executionStatusLine(truncated: boolean, turnsUsed: number, maxTurns: number): string {
  return truncated ? `回合上限截断（${turnsUsed}/${maxTurns}）` : "完成";
}

/** thinking.md 结构化富化（修「思考几 MB 落盘几十 KB」）：除思考流水外，把本执行的工具轨迹、
 *  真实变更清单、最终结论一并写成可读 Markdown —— 下游角色 read 它即可接续，不必重探整条链路。 */
export function buildReadableExecutionBlock(o: {
  sequence: number;
  iso: string;
  output: string;
  handoffTo?: string;
  handoffSummary?: string;
  changedFiles: Array<{ filePath: string; kind: string }>;
  toolsLog: string[];
  thinkingFull: string;
}): string {
  const L: string[] = [`\n---\n## 执行 #${o.sequence} · ${o.iso}`];
  L.push(`### 结论\n${o.output?.trim() || "（无文本结论）"}`);
  if (o.handoffTo) L.push(`### 交接\n→ ${o.handoffTo}${o.handoffSummary ? ` — ${o.handoffSummary}` : ""}`);
  if (o.changedFiles.length > 0) {
    L.push(`### 实际变更文件\n${o.changedFiles.map((f) => `- ${f.kind === "edit" ? "M" : "A"} ${f.filePath}`).join("\n")}`);
  }
  if (o.toolsLog.length > 0) {
    L.push(`### 工具轨迹（实际执行·时间序）\n${o.toolsLog.map((t) => `- ${t}`).join("\n")}`);
  }
  const th = o.thinkingFull?.trim();
  if (th) {
    L.push(th.length > 9000 ? `### 思考流水（节选）\n${th.slice(0, 6000)}\n\n……[中间省略 ${(th.length - 8000).toLocaleString()} 字符] ……\n\n${th.slice(-2000)}` : `### 思考流水\n${th}`);
  }
  return L.join("\n\n");
}

/** 真实执行器：启动 pi 会话跑完整回合 */
export class PiAgentExecutor implements AgentExecutorLike {
  /** 会话工厂：默认调用真实 startRpcSession；测试可注入 mock 会话（发射 thinking/工具事件）验证落盘逻辑 */
  private sessionFactory: typeof startRpcSession;
  constructor(sessionFactory?: typeof startRpcSession) {
    this.sessionFactory = sessionFactory ?? startRpcSession;
  }
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

    // 受控工具（planner 轮额外注入 team_submit_plan）
    const sink = createToolSink();
    const tools = createTeamTools({ team, executingAgentId: agent.id, existingTasks, sink, plannerMode: request.planner === true });

    // —— 写权限策略（工具层角色边界）：显式 writePolicy 优先，缺省推导 = 有 edit → all 否则 docs。
    // docs：剔除内置 edit/write，注入仅限 .md 的受控写工具；none：全部剔除。修 bcfc16cd 越权写码缺陷①。 */
    const writePolicy = resolveWritePolicy(agent);
    const policyToolNames = applyWritePolicyToToolNames(writePolicy, agent.toolNames);
    if (writePolicy === "docs") tools.push(createDocWriteTool(team.cwd));

    // 变更文件采集（edit/write）：跟普通会话一样把「改动的文件」显示出来。
    // 在 tool_execution_start 里按工具名 + 参数路径记录，仅保留站在项目 cwd 内的文件（排除临时脚本/导出）。
    const changedFiles = new Map<string, ChangedFile["kind"]>();

    const model = parseAgentModel(agent.model);
    // 预算分摊：单角色超时不再独占整个 run 时长。优先级：agent.timeoutMs 显式配置（不同角色
    // 耗时天然不同：开发者读码+写入 ≫ 测试跑检查）> DAG 计划实际参与者数分摊 > 团队规模封顶 4 分摊。
    // 旧公式除以全体角色数（含闲置），8 角色团队每人只分到 ~6.4min，深度思考模型读完码就被切断
    // （run 907d9c13 实锤）。给后续未启动角色留 25% 余量。
    const timeoutMs = computeExecutionTimeoutMs({
      maxRunMinutes: team.maxRunMinutes,
      agentCount: team.agents.length,
      participantCount: request.participantCount,
      explicitTimeoutMs: agent.timeoutMs,
    });

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
      appendSummary(`# 角色总结：${agent.name}（${agent.id}）\n> 结论/交接沉淀于此；完整过程（工具轨迹+思考流水+变更清单）：runs/${runId}/thinking/${agent.id}.md（下游直接 read 接续，勿读 jsonl）\n`);
    }

    // 编排模式下入口角色（leader）：允许读代码/写方案（用于需求分析、方案设计、判断难度、拆分任务），
    //   但禁用 edit/bash（不直接改业务代码）——既能让组长读懂现状判断工作难度，又能承担需求分析与方案设计（不再必须依赖 product）。
    //   filter 后为空则传空数组（=禁用所有内置工具，只靠 customTools：建任务/交接/记决策）。
    //   solo 模式：入口角色要“亲自干活”完成整个任务，必须给全套工具（覆盖 leader 默认的 ls/find）。
    //   ——此前实现只用了 agent.toolNames（leader 默认只剩 ls/find），导致 solo 路径无法真正改代码。
    const isOrchestrationEntry = request.mode === "orchestrated" && team.entryAgentId === agent.id;
    const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
    const ENTRY_ANALYSIS_TOOLS = ["read", "write", "grep", "find", "ls"];
    let effectiveToolNames = isOrchestrationEntry
      ? policyToolNames.filter((n) => ENTRY_ANALYSIS_TOOLS.includes(n))
      : request.mode === "solo" && team.entryAgentId === agent.id
        ? FULL_TOOLS
        : policyToolNames;
    // solo 全套工具也必须服从写权限封禁（solo 入口即开发者场景除外：其 writePolicy 通常为 all）
    effectiveToolNames = applyWritePolicyToToolNames(writePolicy, effectiveToolNames);

    // 项目组角色默认开启思维链：项目组任务通常需推理拆解，关闭会明显变蠢。
    // agent.thinkingLevel 显式指定时优先其值；否则默认 medium（跟随 pi 的档位语义）。
    const effectiveThinkingLevel = agent.thinkingLevel ?? "medium";

    // 项目组角色统一禁用个人记忆/待办类工具：memory_*（跨会话记忆）、scratchpad（待办清
    // 单）。这些工具承载的是本机历史会话的“自动检查/待办”类条目，与当前业务任务无关，
    // 角色一旦 memory_search 就易被历史日志劫持（把本次任务当成“再做一次自动检查”，
    // 无视 task 字段里的真实需求）。团队内部协作走 team_* 受控工具，不靠个人记忆。
    const TEAM_DENY_TOOLS = ["memory_list", "memory_search", "memory_save", "memory_forget", "memory_restore", "scratchpad"];

    const { session } = await this.sessionFactory(execution.id, sessionFile, team.cwd, {
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
    let thinkingFull = ""; // 本次执行完整思考流水（用于落 .md 供可读查看；区别于 flush 用的 thinkingBuf）
    let thinkingTimer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    const toolsLog: string[] = []; // 本执行工具轨迹（时间序，落 thinking.md 用）
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

      // —— 回合统计基线 —— 同一角色的 pi 会话跨执行复用，get_session_stats 返回的是
      // 会话【累计】值；先记本轮起点，结束时取差值（见 diffExecutionStats），
      // 否则第 2+ 次执行会把之前的 token/成本重复计入 run.stats（统计虚高）。
      const statsBaseline = await readSessionStats(session);

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
      // 三段式软着陆（参考 @tintinweb/pi-subagents MIT）：达到上限 → steer 收尾指令 →
      // 宽限 N 回合（LLM 消化指令+总结交接）→ 仍未收尾才强制中断。旧实现 steer 一失败就
      // abort 整个回合，兜底机制反噬执行；宽限期让「按时收尾」与「超时截断」两种结局可区分。
      const TURNS_GRACE = 5;
      let turnLimitSteered = false;
      let turnLimitAborted = false;
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
              thinkingFull += am.delta;
              writeTrace(`[thinking] ${am.delta}`);
              if (!thinkingTimer) {
                thinkingTimer = setInterval(flushThinking, 250);
              }
            } else if (am?.type === "thinking_end" && am.content) {
              thinkingBuf = am.content;
              thinkingFull = am.content; // thinking_end 的 content 为完整思考，覆盖增量拼接
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
            if (toolsLog.length < 400) toolsLog.push(summary); // 轨迹全量落盘 thinking.md；此处只设展示上限防极端膨胀
            toolCallCount++;
            if (toolCallCount >= maxTurns && !turnLimitSteered) {
              turnLimitSteered = true;
              const steerMsg = `已达到回合上限（${maxTurns}次工具调用）。请立即收尾：总结当前进度与产物，用 team_handoff 交接给下一个角色（或 __end__ 若任务已全部完成）。不要再次调用读写工具。`;
              writeTrace(`\n[maxTurns] 达到上限，steer 收尾\n`);
              // 修复（高危）：旧实现发 { text } 字段，而 rpc-manager case "steer" 读的是
              // command.message → steer(undefined) → pi agent-session.steer() 首行
              // text.startsWith("/") 抛 TypeError → .catch(abortExecution) 把整个回合静默硬中断
              // （工具调用数达到 maxTurns 的真实高频场景必触发，执行被标 failed/空输出）。
              // ① 字段改为 message ② steer 失败不再 abort——进入宽限回合，耗尽后由下方强制中断兑底。
              void session.send({ type: "steer", message: steerMsg } as never).catch((err: unknown) => {
                writeTrace(`[maxTurns] steer 发送失败：${err instanceof Error ? err.message : String(err)}（宽限回合内继续，耗尽后强制中断）\n`);
              });
            } else if (turnLimitSteered && !turnLimitAborted && toolCallCount >= maxTurns + TURNS_GRACE) {
              // 三段式第 3 段：宽限耗尽仍未收尾 → 强制中断（不再继续烧工具调用）
              turnLimitAborted = true;
              writeTrace(`\n[maxTurns] 宽限 ${TURNS_GRACE} 回合内未收尾，强制中断\n`);
              abortExecution();
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
      const promptPromise = session.inner.prompt(buildInitialPrompt(request.task, request.planner === true ? (request.planError ?? "") : undefined), { source: "rpc" });
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

      // 采集回合统计（token/成本/消息数）：对本轮开头记录的基线取增量——
      // 同角色会话跨执行复用且 get_session_stats 是累计值，不取差值会重复计入 run.stats
      const stats = diffExecutionStats(await readSessionStats(session), statsBaseline);

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
      const { handoff, lastVerdict, lastDecisionContent, decisionRequests, planRequest } = consumeToolRequests(sink, execution.id, agent.id, runId, (e) =>
        request.onEvent(e as TeamEventInput),
      );
      // LLM 故障诚实化：最后一条 assistant 为空且带错误标记（如 provider 403）→ 判 failed，
      // 不再把空输出当 completed 递给重试/调度逻辑（run 84c22d07 实锤修复）。
      // 宽限强制中断（turnLimitAborted）时 prompt 被主动 abort，输出为空是预期行为——
      // 不走 llmError 检测，避免把 stopReason=aborted 误判成「模型调用失败」误导审计与重试。
      const llmError = !output.trim() && !turnLimitAborted ? readLastAssistantLlmError(sessionFile) : undefined;
      if (!llmError && turnLimitAborted) {
        appendSummary(`\n---\n## 执行 #${execution.sequence}\n- 状态：失败\n- 原因：回合上限（${maxTurns}）steer 收尾后宽限 ${TURNS_GRACE} 回合内未收尾，被强制中断\n`);
        onMessage({
          id: `msg-${execution.id}-turnlimit`,
          kind: "agent",
          executionId: execution.id,
          agentId: agent.id,
          role: agent.name,
          content: `⚠️ 本执行达到回合上限（${maxTurns} 次工具调用），steer 收尾指令已在宽限 ${TURNS_GRACE} 回合内未生效，被系统强制中断。已产出的内容如下，未完成的动作可能未真正完成。`,
          createdAt: Date.now(),
        });
        return {
          status: "failed" as const,
          output,
          failureReason: `回合上限（${maxTurns}）宽限 ${TURNS_GRACE} 回合内未收尾，被强制中断`,
          ...(actualModel ? { model: actualModel } : {}),
          ...(changedFiles.size ? { changedFiles: [...changedFiles].map(([filePath, kind]) => ({ filePath, kind })) } : {}),
        };
      }
      if (llmError) {
        appendSummary(`\n---\n## 执行 #${execution.sequence}\n- 状态：失败\n- 原因：模型调用失败 ${llmError.slice(0, 300)}\n`);
        // 群聊可见的诚实失败通告（不能静默无消息：下游/用户需要知道这轮为什么没产出）；
        // 以角色身份（kind=agent）发出——错误归属该角色，UI 分组与「角色无产出」场景一致
        onMessage({
          id: `msg-${execution.id}-llmerr`,
          kind: "agent",
          executionId: execution.id,
          agentId: agent.id,
          role: agent.name,
          content: `❌ 本执行因模型调用失败而中止：${llmError.slice(0, 260)}\n（系统提示：请检查模型配额/提供商可用性后重试）`,
          createdAt: Date.now(),
        });
        return {
          status: "failed" as const,
          output: "",
          failureReason: `模型调用失败：${llmError.slice(0, 400)}`,
          ...(actualModel ? { model: actualModel } : {}),
          ...(changedFiles.size ? { changedFiles: [...changedFiles].map(([filePath, kind]) => ({ filePath, kind })) } : {}),
        };
      }
      // DAG 编排：planner 轮提交的计划 → 二次校验（工具内校验过，防御性复验）后透出给调度器
      let plan: PlanTask[] | undefined;
      let planError: string | undefined;
      if (request.planner) {
        if (planRequest) {
          const verdict = validatePlanSubmission(team, planRequest.tasks);
          if (verdict.ok) plan = verdict.tasks;
          else planError = verdict.error;
        } else {
          planError = "未调用 team_submit_plan 提交计划";
        }
      }

      // 产出群聊消息（恒非空兜底）：角色最后一轮可能既无文本、又无交接、又无文件变更
      //   （典型：只读探索后被回合上限收尾）——旧逻辑三分支都落空→静默无消息。现在任何情况都可见，
      //   并叠加：真实变更清单恒显示、假宣称警示（修 fe-developer 假汇报）、截断诚实标注。
      const changedFileList = [...changedFiles].map(([filePath, kind]) => ({ filePath, kind }));
      const truncated = turnLimitSteered;
      const fallback = buildFallbackGroupMessage({
        output,
        handoffSummary: handoff?.summary,
        changedFiles: changedFileList,
        truncated,
        turnsUsed: toolCallCount,
        maxTurns,
        detailHint: `runs/${runId}/thinking/${agent.id}.md`,
      });
      onMessage({
        id: `msg-${execution.id}`,
        kind: "agent",
        executionId: execution.id,
        agentId: agent.id,
        role: agent.name,
        content: fallback.content,
        createdAt: Date.now(),
      });
      // 结构化 verdict 缺位警示：条件路由将退化为关键词匹配（修 bcfc16cd 缺陷④⑥的可见性部分）
      if (decisionRequests === 0 && !lastVerdict && (handoff || truncated)) {
        onMessage({
          id: `msg-${execution.id}-verdict-warn`,
          kind: "system",
          executionId: execution.id,
          agentId: agent.id,
          role: "",
          content: `⚠️ 流程提示：角色「${agent.name}」结束本执行时未调用 team_record_decision 记录 pass/fail 结论，后续条件路由只能退化为关键词匹配，易误派返工对象（如前端问题被路由到后端角色）。`,
          createdAt: Date.now(),
        });
      }

      // 把本次执行结论沉淀到「每角色一份」的总结 .md（供交接/下游角色读取）
      try {
        appendSummary([
          `\n---\n## 执行 #${execution.sequence}`,
          `- 模型：${actualModel ? `${actualModel.provider}/${actualModel.modelId}` : "(未解析)"}`,
          `- 状态：${executionStatusLine(truncated, toolCallCount, maxTurns)}`, // 不再硬编码“完成”——截断诚实化（缺陷⑤）
          `- 工具调用：${toolCallCount}/${maxTurns}${changedFileList.length ? `｜实际变更文件 ${changedFileList.length} 个` : ""}`, 
          `- 交接：${handoff ? `${handoff.to}${handoff.summary ? ` — ${handoff.summary.slice(0, 500)}` : ""}` : "（无）"}`,
          `- 结论：${(output.trim() || "（无输出）").slice(0, 1600)}`,
        ].join("\n"));
      } catch { /* 总结写入失败不阻断 */ }

      // 执行记录落 .md（可读、富化）：runs/<runId>/thinking/<agentId>.md
      //   结构化包含：结论 + 交接 + 真实变更清单 + 完整工具轨迹 + 思考流水——下游角色 read 这一个
      //   文件即可接续工作，无需重探链路（修「重复探索→40分钟超长 run」），也不必去读 JSONL。
      let thinkingPath: string | undefined;
      try {
        if (thinkingFull?.trim() || toolsLog.length > 0 || output.trim() || handoff) {
          const thinkingDir = join(getTeamDir(team.sessionId), "runs", runId, "thinking");
          mkdirSync(thinkingDir, { recursive: true });
          const thinkingFile = join(thinkingDir, `${agent.id}.md`);
          appendFileSync(
            thinkingFile,
            buildReadableExecutionBlock({
              sequence: execution.sequence,
              iso: new Date().toISOString(),
              output,
              handoffTo: handoff?.to,
              handoffSummary: handoff?.summary?.slice(0, 1200),
              changedFiles: changedFileList,
              toolsLog,
              thinkingFull,
            }) + "\n",
          );
          thinkingPath = thinkingFile;
        }
      } catch { /* 思考流水写入失败不阻断 */ }

      return {
        status: "completed",
        output: output.trim(),
        ...(handoff ? { handoffTool: { to: handoff.to, summary: handoff.summary, artifacts: handoff.artifacts, blockers: handoff.blockers } } : {}),
        // P1-1：只有 pass/fail 才作为路由信号，info 不算
        ...(lastVerdict === "pass" || lastVerdict === "fail" ? { verdict: lastVerdict } : {}),
        ...(lastDecisionContent ? { decisionContent: lastDecisionContent } : {}),
        // DAG 编排：planner 轮提交的计划（调度器据此派发）；失败时附错误供纠错重试
        ...(plan ? { plan } : {}),
        ...(request.planner && planError ? { planError } : {}),
        ...(stats ? { stats } : {}),
        ...(actualModel ? { model: actualModel } : {}),
        ...(changedFiles.size ? { changedFiles: [...changedFiles].map(([filePath, kind]) => ({ filePath, kind })) } : {}),
        ...(thinkingPath ? { thinkingPath } : {}),
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

/** get_session_stats 的原始返回形状（注意：是会话【累计】口径，非单轮） */
interface SessionStatsRaw {
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: number;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  toolResults?: number;
  totalMessages?: number;
  sessionFile?: string;
}

/** 读当前累计统计（失败返回 null，不阻断执行） */
async function readSessionStats(session: { send: (command: Record<string, unknown>) => Promise<unknown> }): Promise<SessionStatsRaw | null> {
  try {
    return (await session.send({ type: "get_session_stats" })) as SessionStatsRaw | null;
  } catch {
    return null;
  }
}

const finiteNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 累计值 → 本轮增量：同角色多次执行复用同一会话文件，直接上报累计值会让第 2+ 次执行的
 *  token/成本被重复计入 run.stats。用本轮开头记录的基线取非负差值得到真实增量；
 *  基线缺失时退化为原值（保持旧行为）。 */
function diffExecutionStats(raw: SessionStatsRaw | null, baseline: SessionStatsRaw | null): ExecutionStats | undefined {
  if (!raw) return undefined;
  const delta = (cur: unknown, prev: unknown): number =>
    baseline ? Math.max(finiteNum(cur) - finiteNum(prev), 0) : finiteNum(cur);
  return {
    inputTokens: delta(raw.tokens?.input, baseline?.tokens?.input),
    outputTokens: delta(raw.tokens?.output, baseline?.tokens?.output),
    cacheReadTokens: delta(raw.tokens?.cacheRead, baseline?.tokens?.cacheRead),
    cacheWriteTokens: delta(raw.tokens?.cacheWrite, baseline?.tokens?.cacheWrite),
    totalTokens: delta(raw.tokens?.total, baseline?.tokens?.total),
    cost: delta(raw.cost, baseline?.cost),
    userMessages: delta(raw.userMessages, baseline?.userMessages),
    assistantMessages: delta(raw.assistantMessages, baseline?.assistantMessages),
    toolCalls: delta(raw.toolCalls, baseline?.toolCalls),
    toolResults: delta(raw.toolResults, baseline?.toolResults),
    totalMessages: delta(raw.totalMessages, baseline?.totalMessages),
  };
}

/** 带超时的执行（超时 abort 后判定 failed/timeout）。
 *  onExternalAbort：仅异常路径（超时兜底 / 用户取消经 raceWithAbort reject）触发——发送底层 abort 并清理监听；正常完成不误发 abort。
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
  } catch (error) {
    onExternalAbort?.();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 把 promise 与取消信号竞争：信号中止时立即 reject（提前返回，不等底层 LLM/会话挂起），
 *  onAbort 用于发送底层 abort（尽力为之）。无 signal 时原样返回 promise。
 *  监听自清理：无论成功失败，settle 后从共享的 run 级 signal 上摘掉本次监听——
 *  同一 signal 跨多角色/多波次复用，不摘会随执行次数无界增长。 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (!signal) return promise;
  let fire: () => void = () => undefined;
  const cancelPromise = new Promise<never>((_, reject) => {
    fire = () => {
      try { onAbort(); } catch { /* 忽略 */ }
      reject(new Error("用户取消执行"));
    };
    if (signal.aborted) fire();
    else signal.addEventListener("abort", fire, { once: true });
  });
  void promise
    .catch(() => undefined)
    .finally(() => signal.removeEventListener("abort", fire));
  return Promise.race([promise, cancelPromise]);
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
