/**
 * 计划模式（Plan Mode）—— 只读调研 → 提交分阶段计划 → 用户勾选 → 执行。
 *
 * 本文件只放纯逻辑（可单测）：模式指令文本、计划解析、[DONE:n] 进度归约、
 * 执行消息构造。服务端（rpc-manager 的 inject_context）与客户端
 * （useAgentSession / PlanApprovalCard）共用同一套约定，避免前后端对计划
 * 格式理解不一致。
 *
 * 设计对齐 pi 官方 examples/extensions/plan-mode：只读工具集 + 隐藏上下文
 * 消息 + `计划:`/`Plan:` 编号列表 + `[DONE:n]` 进度标记。区别是本实现完全
 * 由 pi-studio 宿主驱动（原生 UI 勾选阶段），不依赖用户安装扩展。
 *
 * 注意：普通会话**不启用**计划配套工具（update_plan / ask_user），见
 * PLAN_MODE_CUSTOM_TOOL_NAMES——它们在每次 prompt 前由客户端按当前模式
 * 显式启用/禁用；历史会话里已有的计划消息仍会被 PlanApprovalCard 渲染。
 */

import type { AgentMessage } from "./types";

/** 注入到 Agent 上下文的隐藏 custom message 类型（deliverAs:"nextTurn"，不落盘不显示） */
export const PLAN_MODE_CONTEXT_CUSTOM_TYPE = "plan-mode-context";
export const PLAN_MODE_OFF_CUSTOM_TYPE = "plan-mode-off";

/** Codex 同款的分步计划工具名（pending / in_progress / completed 实时清单） */
export const UPDATE_PLAN_TOOL_NAME = "update_plan";

/** 计划模式下允许的内置工具（只读；不含 bash/edit/write，物理上无法改文件） */
export const PLAN_MODE_TOOL_NAMES: string[] = ["read", "grep", "find", "ls"];

/**
 * 计划模式配套的自定义工具名（服务端注册，名字必须与 lib/plan-tool.ts 一致）。
 * 普通会话里必须显式从激活集里剔除：否则模型会自己调 update_plan 摆出计划清单、
 * 或在没开计划模式时弹 ask_user 选项，等于把计划模式混进了普通会话。
 */
export const PLAN_MODE_CUSTOM_TOOL_NAMES: string[] = ["update_plan", "ask_user"];

/** 单个计划最多保留的阶段数（防止模型输出超长清单拖垮面板） */
export const MAX_PLAN_STAGES = 30;

/** 阶段文本最大长度（超出截断，仅用于展示，不影响编号对齐） */
const MAX_STAGE_TEXT = 160;

export type PlanStageStatus = "pending" | "in_progress" | "completed";

export interface PlanStage {
  /** 计划中的原始编号（1-based；文本计划的 `[DONE:n]` 与之对应） */
  step: number;
  text: string;
  done: boolean;
  /** update_plan 工具给出的实时状态；文本计划缺省视为 pending */
  status?: PlanStageStatus;
}

/** 兼容：把可选的 status 归一成三态（缺省按 done 推断） */
export function stageStatus(stage: PlanStage): PlanStageStatus {
  if (stage.status) return stage.status;
  return stage.done ? "completed" : "pending";
}

/** 计划模式激活时注入的上下文（每次 prompt 前注入一次，transient 不累积） */
export function planModeInstruction(): string {
  return [
    "[PLAN MODE ACTIVE] 你现在处于「计划模式」（只读调研）。",
    "写入/编辑文件、执行命令的工具已被禁用；你只能读代码和检索。",
    "",
    "要求：",
    "1. 先充分阅读/检索相关代码，把问题和方案调研清楚，不要凭空猜。",
    "2. 不要修改任何文件，也不要尝试执行命令。",
    "3. 调研完成后，调用 update_plan 工具提交分阶段计划：每个 step 一句话（可执行、可验证），status 全部填 pending，3~10 个。",
    "   示例：update_plan({ plan: [{ step: \"梳理命令分发结构\", status: \"pending\" }, { step: \"新增单测\", status: \"pending\" }] })",
    "4. 调研中遇到会改变方案走向的歧义点（技术选型、两种实现路径、范围/兼容性取舍、破坏性改动），先用 ask_user 给出具体选项让用户拍板，拿到答复后再定稿计划；不要替用户决定。",
    "5. 阶段粒度适中（通常 3~10 个），每个阶段都必须是可执行动作。",
    "6. 提交计划后立即停止，等待用户在界面上批准/勾选；不要自行开始执行。",
  ].join("\n");
}

/** 计划模式关闭时注入的上下文（恢复完整工具权限） */
export function planModeOffInstruction(): string {
  return "[PLAN MODE OFF] 计划模式已关闭，完整工具权限已恢复，可以正常编辑文件与执行命令。";
}

/** 清洗单条阶段文本：去掉 markdown 强调/行内代码与残留完成标记 */
export function cleanStageText(raw: string): string {
  let text = raw
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[DONE:\d+\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  // 去掉行尾孤立的 markdown 标记（模型常写 "**" 结尾）
  text = text.replace(/[*_`~]+$/g, "").trim();
  if (text.length > MAX_STAGE_TEXT) text = `${text.slice(0, MAX_STAGE_TEXT - 1)}…`;
  return text;
}

/**
 * 从一段 assistant 文本中解析「计划：」/「Plan:」标题下的编号列表。
 * 没有标题行则返回 []（避免把普通编号列表误判成计划）。
 */
export function extractPlanStages(text: string): PlanStage[] {
  if (!text) return [];
  const header = text.match(/(?:^|\n)[ \t>*#-]*\*{0,2}[ \t]*(?:计划|Plan)[ \t]*\*{0,2}[ \t]*[:：]/i);
  if (!header || header.index === undefined) return [];

  const section = text.slice(header.index + header[0].length);
  const stages: PlanStage[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d{1,3})\s*[.)、．:：]\s*(.+?)\s*$/);
    if (!match) continue;
    const step = Number(match[1]);
    if (!Number.isFinite(step) || step <= 0) continue;
    const cleaned = cleanStageText(match[2]);
    if (cleaned.length < 2) continue;
    if (stages.some((stage) => stage.step === step)) continue;
    stages.push({ step, text: cleaned, done: false });
    if (stages.length >= MAX_PLAN_STAGES) break;
  }
  return stages;
}

/** 提取文本中所有 `[DONE:n]` 标记的编号 */
export function extractDoneSteps(text: string): number[] {
  if (!text) return [];
  const steps: number[] = [];
  for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

/** 按完成标记把对应阶段置为 done（返回新数组，不修改入参） */
export function markStagesDone(stages: PlanStage[], doneSteps: number[]): PlanStage[] {
  if (doneSteps.length === 0) return stages;
  const done = new Set(doneSteps);
  return stages.map((stage) => (done.has(stage.step) ? { ...stage, done: true, status: "completed" as const } : stage));
}

/**
 * 从 update_plan 工具结果的 details 提取阶段（Codex 同款：数组顺序即阶段编号）。
 * 兼容字段：step / text / content 作为文案，status 三态。
 */
export function extractUpdatePlanStages(details: unknown): PlanStage[] {
  const d = details as { plan?: unknown } | null | undefined;
  if (!d || !Array.isArray(d.plan)) return [];
  const stages: PlanStage[] = [];
  for (const raw of d.plan) {
    const item = raw as { step?: unknown; text?: unknown; content?: unknown; status?: unknown } | null | undefined;
    const rawText =
      typeof item?.step === "string" ? item.step
      : typeof item?.text === "string" ? item.text
      : typeof item?.content === "string" ? item.content
      : "";
    const cleaned = cleanStageText(rawText);
    if (!cleaned) continue;
    const status: PlanStageStatus =
      item?.status === "completed" || item?.status === "in_progress" ? item.status : "pending";
    stages.push({ step: stages.length + 1, text: cleaned, done: status === "completed", status });
    if (stages.length >= MAX_PLAN_STAGES) break;
  }
  return stages;
}

/** 取 assistant 消息的纯文本（thinking/toolCall 块忽略） */
export function getAssistantText(message: AgentMessage | undefined | null): string | null {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return null;
  const text = message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * 从整段消息流推导当前计划与进度：
 * 1) 优先用最近一次 update_plan 工具结果（Codex 同款实时清单，状态最准）；
 * 2) 否则退回到文本方案：最近一条含「计划：」标题的 assistant 消息 + 其后的 `[DONE:n]` 标记；
 * 3) 没有计划时返回 []。
 */
export function derivePlanStages(messages: AgentMessage[]): PlanStage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "toolResult" && message.toolName === UPDATE_PLAN_TOOL_NAME) {
      const stages = extractUpdatePlanStages(message.details);
      if (stages.length > 0) return stages;
    }
  }

  let anchor = -1;
  let stages: PlanStage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = getAssistantText(messages[i]);
    if (!text) continue;
    const parsed = extractPlanStages(text);
    if (parsed.length > 0) {
      anchor = i;
      stages = parsed;
      break;
    }
  }
  if (anchor < 0) return [];

  const doneSteps: number[] = [];
  for (let i = anchor; i < messages.length; i++) {
    const text = getAssistantText(messages[i]);
    if (text) doneSteps.push(...extractDoneSteps(text));
  }
  return markStagesDone(stages, doneSteps);
}

/**
 * 逐步执行：只跑一个阶段，完成后停下等用户确认。
 * 与 buildPlanExecutionMessage（一次性跑完）相对。
 */
export function buildPlanStepMessage(stage: PlanStage): string {
  return [
    `[执行计划·第 ${stage.step} 阶段]`,
    `用户确认只执行本阶段：${stage.text}`,
    "",
    `只做这一件事：完成后立即停止，不要顺手继续后面的阶段，也不重新规划。`,
    "直接用你的完整工具权限执行；逐步模式下不需要维护计划清单，也不要重新规划。",
    `请在回复末尾输出 [DONE:${stage.step}]，然后等待用户确认下一步。`,
  ].join("\n");
}
/**
 * 用户勾选阶段后发给 Agent 的执行指令。stages 保留原始编号（可能不连续），
 * 便于把 `[DONE:n]` 进度标记映射回面板。
 */
export function buildPlanExecutionMessage(stages: PlanStage[]): string {
  const lines = stages.map((stage) => `${stage.step}. ${stage.text}`).join("\n");
  return [
    "[开始执行计划]",
    "计划模式已关闭，完整工具权限已恢复。请只执行下列已批准的阶段（未列出的阶段一律不要执行，也不要重新规划）：",
    "",
    lines,
    "",
    "请按编号顺序执行；执行中不再维护计划清单（update_plan 已禁用），完成后在回复里用 [DONE:n] 标记已完成的阶段编号。",
    "若执行中遇到会改变方向的歧义（技术选型 / 范围取舍 / 破坏性改动），停下来在回复里列出候选方案让用户拍板，再继续。",
  ].join("\n");
}
