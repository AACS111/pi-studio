/**
 * ContextEngine（设计稿 v5 §7.5）：结构化共享上下文构建。
 * 三层结构（不注入聊天全文）：
 *   【任务】run.task + phase + 任务列表
 *   【当前进度】lastHandoff + decisions + blockers + 各角色最近摘要
 *   【最近消息】按 contextScope（structured/summary/recent）
 *   【产物】ArtifactRef 清单（角色 read 自行验证，不塞文件内容）
 */
import type { AgentDef, Projections, TeamDef, TeamMessage, TeamRun } from "./types.ts";

export interface ContextBuildOptions {
  team: TeamDef;
  run: TeamRun;
  projections: Projections;
  agent: AgentDef;
}

/** 从消息投影提取每个角色的最近一条产出摘要 */
function recentAgentSummaries(messages: TeamMessage[]): Array<{ agentId: string; role: string; summary: string }> {
  const byAgent = new Map<string, TeamMessage>();
  for (const m of messages) {
    if (m.kind === "agent" && m.agentId) byAgent.set(m.agentId, m);
  }
  return [...byAgent.entries()].map(([agentId, m]) => ({
    agentId,
    role: m.role ?? agentId,
    summary: summarize(m.content),
  }));
}

function summarize(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

function listLines(items: string[]): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "（无）";
}

export function buildContext(options: ContextBuildOptions): string {
  const { team, run, projections, agent } = options;
  const state = projections.state;
  const scope = agent.contextPolicy?.scope ?? team.contextScope;

  // 最近消息：按 scope
  let recentBlock = "";
  if (scope === "structured" || scope === "recent") {
    const relevant = projections.messages.filter((m) => m.kind === "user" || m.kind === "agent" || m.kind === "handoff");
    const recentCount = scope === "recent" ? (agent.contextPolicy?.recentCount ?? team.recentCount ?? 20) : undefined;
    const slice = recentCount ? relevant.slice(-recentCount) : relevant;
    recentBlock = `\n## 最近消息\n${slice.length > 0 ? slice.map((m) => `[${m.kind === "agent" ? (m.role ?? m.agentId) : m.kind === "user" ? "用户" : "交接"}] ${summarize(m.content, 300)}`).join("\n") : "（暂无）"}\n`;
  }

  const decisionsBlock = state.decisions.length > 0
    ? state.decisions.map((d) => `- [${d.madeBy}] ${d.content}${d.relatedTaskId ? `（${d.relatedTaskId}）` : ""}`).join("\n")
    : "（暂无）";

  const summaries = recentAgentSummaries(projections.messages);
  const summariesBlock = summaries.length > 0
    ? summaries.map((s) => `- ${s.role}（${s.agentId}）：${s.summary}`).join("\n")
    : "（暂无）";

  return [
    `# 项目组工作上下文（你的角色：${agent.name}）`,
    `\n## 任务`,
    run.task,
    `\n## 当前进度`,
    `阶段：${state.phase ?? "planning"}`,
    state.lastHandoff
      ? `最近交接：${state.lastHandoff.from} → ${state.lastHandoff.to}${state.lastHandoff.reason ? `（${state.lastHandoff.reason}）` : ""}`
      : "最近交接：（无）",
    `已完成任务：\n${listLines(state.completedTasks.map((id) => taskTitle(projections, id)))}`,
    `进行中任务：\n${listLines(state.activeTasks.map((id) => taskTitle(projections, id)))}`,
    `关键决策：\n${decisionsBlock}`,
    `阻塞项：\n${listLines(state.blockers)}`,
    `各角色最近产出：\n${summariesBlock}`,
    recentBlock,
    `## 产物（ArtifactRef，请自行 read 验证）`,
    state.artifacts.length > 0
      ? state.artifacts.map((a) => `- ${a.path}（${a.type}${a.description ? `：${a.description}` : ""}，由 ${a.createdBy} 在 ${a.producedByExecutionId} 产生）`).join("\n")
      : "（暂无）",
    ``,
  ].join("\n");
}

function taskTitle(projections: Projections, taskId: string): string {
  const task = projections.tasks.find((t) => t.id === taskId);
  return task ? `${taskId} ${task.title}` : taskId;
}

/** 组合角色 systemPrompt + 共享上下文（注入 startRpcSession systemPrompt 覆盖） */
export function buildAgentSystemPrompt(agent: AgentDef, context: string): string {
  return `${agent.systemPrompt}\n\n${context}`;
}
