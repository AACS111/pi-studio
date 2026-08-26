/**
 * ContextEngine（设计稿 v5 §7.5）：结构化共享上下文构建。
 *
 * 优化版（2026-08）：上下文/流水分文件。
 *   - 上下文里只传「摘要 + trace 指针 + 产物路径」，不传完整产出正文
 *   - 每个角色执行的完整思考流水/工具调用过程落盘到 traces/<execId>.md
 *   - 下游角色需要详情时自行 read traces/<execId>.md
 *
 * 这样每角色 prompt 稳定在 ~2KB 以内（旧版会膨胀到 7KB+），
 * 模型推理快、回合少、不重复读已有内容。
 */
import type { AgentDef, Projections, TeamDef, TeamMessage, TeamRun } from "./types.ts";

export interface ContextBuildOptions {
  team: TeamDef;
  run: TeamRun;
  projections: Projections;
  agent: AgentDef;
}

/** trace 文件相对路径（基于 executionId）；落盘于 <teamDir>/runs/<runId>/traces/<execId>.md */
function tracePath(executionId: string): string {
  return `traces/${executionId}.md`;
}

/** 任务 DAG + 期望产出一行（P1-3 共享计划黑板） */
function taskDagLines(
  tasks: Array<{ id: string; title: string; status: string; assignedAgentId: string; expectedOutput?: string; dependsOn?: string[]; parentTaskId?: string }>,
): string {
  if (tasks.length === 0) return "（暂无）";
  return tasks
    .map((t) => {
      const dep = t.dependsOn?.length ? `（前置：${t.dependsOn.join(",")}）` : "";
      const parent = t.parentTaskId ? `（父：${t.parentTaskId}）` : "";
      const exp = t.expectedOutput ? `｜验收：${t.expectedOutput}` : "";
      return `- ${t.id} [${t.status}] ${t.title} → ${t.assignedAgentId}${dep}${parent}${exp}`;
    })
    .join("\n");
}

function summarize(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

function listLines(items: string[]): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "（无）";
}

/** 前序角色摘要（合并块）：每个角色一行——角色名 + 一句话结论 + trace 指针
 *  替代旧版 predecessorBlock + chainBlock + summariesBlock 三重重复 */
function predecessorSummaries(
  messages: TeamMessage[],
  excludeAgentId: string,
  max = 5,
): string {
  // 取最近的 agent 消息（每个 agent 只留最后一条），排除当前角色自己
  const byAgent = new Map<string, TeamMessage>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind !== "agent" || !m.agentId || m.agentId === excludeAgentId) continue;
    if (!byAgent.has(m.agentId)) byAgent.set(m.agentId, m);
  }
  const entries = [...byAgent.entries()].slice(0, max);
  if (entries.length === 0) return "（暂无）";
  return entries
    .map(([agentId, m]) => {
      const role = m.role ?? agentId;
      const summary = summarize(m.content, 160);
      const trace = m.executionId ? `｜trace: ${tracePath(m.executionId)}` : "";
      return `- ${role}（${agentId}）：${summary}${trace}`;
    })
    .join("\n");
}

/** 最近交接摘要（替代旧版全量 recentBlock） */
function recentHandoffsAndMessages(messages: TeamMessage[], max = 4): string {
  const relevant = messages.filter((m) => m.kind === "user" || m.kind === "handoff" || m.kind === "agent");
  const slice = relevant.slice(-max);
  if (slice.length === 0) return "（暂无）";
  return slice
    .map((m) => {
      const tag = m.kind === "agent" ? (m.role ?? m.agentId ?? "agent") : m.kind === "user" ? "用户" : "交接";
      return `[${tag}] ${summarize(m.content, 120)}`;
    })
    .join("\n");
}

export function buildContext(options: ContextBuildOptions): string {
  const { run, projections, agent } = options;
  const state = projections.state;

  // P0-4：本角色期望产出/验收标准
  const expectationBlock = agent.expectation ? `\n## 本角色期望产出\n${agent.expectation}\n` : "";

  // 前序角色摘要（合并块，含 trace 指针）
  const predecessors = predecessorSummaries(projections.messages, agent.id);

  // 最近消息/交接（限量）
  const recentBlock = recentHandoffsAndMessages(projections.messages);

  // 共享任务 DAG
  const dagBlock = taskDagLines(projections.tasks);

  // 关键决策（去重：同 agentId 连续记录只留最新）
  const decisionsBlock = state.decisions.length > 0
    ? state.decisions
        .filter((d, i, arr) => i === arr.lastIndexOf(arr.find((x) => x.madeBy === d.madeBy) ?? d))
        .map((d) => `- [${d.madeBy}] ${summarize(d.content, 200)}${d.verdict ? `【${d.verdict === "pass" ? "通过" : d.verdict === "fail" ? "失败" : "参考"}】` : ""}`)
        .join("\n")
    : "（暂无）";

  const artifactsBlock = state.artifacts.length > 0
    ? state.artifacts
        .map((a) => `- ${a.path}（${a.type}，由 ${a.createdBy} 产生）`)
        .join("\n")
    : "（暂无）";

  return [
    `# 项目组工作上下文（你的角色：${agent.name}）`,
    `\n## 任务`,
    run.task,
    expectationBlock,
    `\n## 当前进度`,
    `阶段：${state.phase ?? "planning"}｜模式：${run.complexity === "simple" ? "solo（你一人完成）" : "多角色协作"}`,
    state.lastHandoff
      ? `最近交接：${state.lastHandoff.from} → ${state.lastHandoff.to}`
      : "最近交接：（无）",
    `\n## 前序角色摘要（需详情请 read 对应 trace 文件）`,
    predecessors,
    `\n## 共享任务列表（DAG 概览）`,
    dagBlock,
    `已完成：${listLines(state.completedTasks.map((id) => taskTitle(projections, id)))}`,
    `进行中：${listLines(state.activeTasks.map((id) => taskTitle(projections, id)))}`,
    `\n## 关键决策`,
    decisionsBlock,
    `\n## 最近消息`,
    recentBlock,
    `\n## 产物（请自行 read 验证）`,
    artifactsBlock,
    ``,
  ].join("\n");
}

function taskTitle(projections: Projections, taskId: string): string {
  const task = projections.tasks.find((t) => t.id === taskId);
  return task ? `${taskId} ${task.title}` : taskId;
}

/** 组合角色 systemPrompt + 共享上下文（注入 startRpcSession systemPrompt 覆盖） */
export function buildAgentSystemPrompt(agent: AgentDef, context: string, mode?: "solo" | "orchestrated"): string {
  // 编排模式下的入口角色（leader）追加严格约束：禁止读业务代码/探查结构，只做拆任务+派活+记决策
  // solo 模式不加约束（leader 一个人全做，需要读写代码）
  const roleGuard = mode === "orchestrated"
    ? `\n\n## 编排纪律（复杂任务，严格遵守）\n- 你是入口角色，只做：拆任务 + team_create_task + team_handoff 派活 + team_record_decision 记决策。\n- 禁止 read 业务代码/grep 项目结构/探查实现细节——那是下游角色（研究员/开发等）的职责。\n- 规划阶段工具调用上限：6 次（建任务+交接+决策），超过即视为越界。\n- 拆完任务立即 handoff 给第一个下游角色，不要自己动手实现。\n`
    : "";
  const endGuidance = `

## 交接与结束（严格遵守）
- 只有确实需要下游角色处理（如修复、验证、补充信息）时才调用 team_handoff 交给对应角色。
- **若你判断整个任务的目标已全部达成、你的输出就是最终交付结果，请调用 team_handoff(to: "__end__") 结束本次运行。**
- 不要为了"走工作流"而把已完成的工作重复交接给其他角色；这会造成指令空转、浪费资源。
`;
  return `${agent.systemPrompt}${roleGuard}${endGuidance}\n\n${context}`;
}
