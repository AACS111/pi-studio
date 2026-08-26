/**
 * 项目组受控工具集（设计稿 v5 §7.2）。
 *
 * Agent 影响团队状态的唯一途径。工具 execute 只做：参数校验 → 把「请求」
 * push 到 sink（collector）。Runtime（AgentExecutor）在会话结束后统一消费
 * sink → 产生 Event → 投影更新。工具本身不写事件文件（保持单写者）。
 *
 * 错误校验（self-loop / 白名单外 / 目标不存在 / 任务不存在）在 execute 内
 * 以结果文本返回给 Agent，让它自行修正——不产生任何状态变更。
 */
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentDef, ArtifactRef, TeamDef, TeamTask } from "./types.ts";

/** 受控工具请求（合法调用才会进入 sink） */
export type TeamToolRequest =
  | { kind: "handoff"; to: string; summary: string; artifacts?: string[]; blockers?: string[] }
  | { kind: "create_task"; title: string; description?: string; assignedAgentId?: string; parentTaskId?: string }
  | { kind: "complete_task"; taskId: string }
  | { kind: "add_artifact"; path: string; type?: ArtifactRef["type"]; description?: string }
  | { kind: "record_decision"; content: string; relatedTaskId?: string; verdict?: "pass" | "fail" | "info" };

export interface TeamToolSink {
  requests: TeamToolRequest[];
}

export function createToolSink(): TeamToolSink {
  return { requests: [] };
}

export interface CreateTeamToolsOptions {
  team: TeamDef;
  executingAgentId: string;
  existingTasks: TeamTask[];
  sink: TeamToolSink;
}

function text(content: string) {
  return [{ type: "text" as const, text: content }];
}

/** 校验并记录一次工具请求；非法时返回错误文本，合法返回 null */
function validateAndCollect(
  options: CreateTeamToolsOptions,
  request: TeamToolRequest,
): string | null {
  const { team, executingAgentId, sink } = options;

  if (request.kind === "handoff") {
    const target = team.agents.find((a) => a.id === request.to);
    if (!target) {
      return `错误：目标角色 "${request.to}" 不存在。可用角色：${team.agents.map((a) => a.id).join(", ")}`;
    }
    const agent = team.agents.find((a) => a.id === executingAgentId);
    const policy = agent?.handoffPolicy;
    if (!policy?.allowSelfHandoff && request.to === executingAgentId) {
      return `错误：不能交接给自己（${executingAgentId}）。请选择其他角色或结束流程。`;
    }
    if (policy?.allowedTargets && policy.allowedTargets.length > 0 && !policy.allowedTargets.includes(request.to)) {
      return `错误：角色 ${executingAgentId} 只允许交接给：${policy.allowedTargets.join(", ")}`;
    }
    if (!request.summary?.trim()) {
      return "错误：handoff 需要 summary（工作摘要）。";
    }
  } else if (request.kind === "create_task") {
    if (!request.title?.trim()) return "错误：create_task 需要 title。";
    if (request.assignedAgentId && !team.agents.some((a) => a.id === request.assignedAgentId)) {
      return `错误：assignedAgentId "${request.assignedAgentId}" 不存在。`;
    }
  } else if (request.kind === "complete_task") {
    if (!options.existingTasks.some((t) => t.id === request.taskId)) {
      return `错误：任务 "${request.taskId}" 不存在。当前任务：${options.existingTasks.map((t) => `${t.id}(${t.title})`).join(", ") || "（无）"}`;
    }
  } else if (request.kind === "add_artifact") {
    if (!request.path?.trim()) return "错误：add_artifact 需要 path。";
  } else if (request.kind === "record_decision") {
    if (!request.content?.trim()) return "错误：record_decision 需要 content。";
  }

  sink.requests.push(request);
  return null;
}

/**
 * 创建受控工具（注入 startRpcSession 的 customTools）。
 * 工具名与角色 systemPrompt 中的交接协议一致。
 */
export function createTeamTools(options: CreateTeamToolsOptions): ToolDefinition[] {
  const collect = (request: TeamToolRequest) => validateAndCollect(options, request);

  const handoff = defineTool({
    name: "team_handoff",
    label: "交接给项目组成员",
    description:
      "将当前工作交接给项目组中的另一个角色（Runtime 正式控制协议）。交接摘要、产物路径、阻塞项会写入项目记录，下一角色将基于此继续。\n\n重要：若你判断整个任务的最终交付已经达成、不需要任何下游角色再处理时，将 to 设为 __end__ 结束本次运行；不要为了走流程而把已完成的工作再交给下一个角色接力。",
    promptSnippet: "team_handoff 用于把工作交接给项目组中的下一个角色；任务已全面完成时 to 传 __end__ 结束",
    promptGuidelines: [
      "交接必须写清：交接对象、工作摘要（200 字内）、产物文件路径（如有）。",
      "产物写文件路径，让下一角色 read 验证，不要只写“已完成”。",
      "有问题时交接给负责修复的角色；全部通过时交接给组长收尾。",
      "若你判断整个任务目标已全部达成、无需任何下游处理，交接 to=__end__ 结束运行；不得为了走工作流而重复接力已完成的环节。",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "目标角色 id；若整个任务已交付完成，填 __end__ 结束运行" }),
      summary: Type.String({ description: "工作摘要（200 字内）" }),
      artifacts: Type.Optional(Type.Array(Type.String(), { description: "产物文件路径" })),
      blockers: Type.Optional(Type.Array(Type.String(), { description: "阻塞项" })),
    }),
    execute: async (_toolCallId, params) => {
      const error = collect({
        kind: "handoff",
        to: params.to,
        summary: params.summary,
        artifacts: params.artifacts,
        blockers: params.blockers,
      });
      return {
        content: text(
          error ??
            `已交接给 ${params.to}。摘要：${params.summary.slice(0, 120)}${params.artifacts?.length ? `（产物：${params.artifacts.join(", ")}）` : ""}`,
        ),
        details: { ok: !error, kind: "handoff" },
      };
    },
  });

  const createTask = defineTool({
    name: "team_create_task",
    label: "创建子任务",
    description: "创建一条子任务（记录在项目任务列表，便于追踪）。",
    promptSnippet: "team_create_task 创建一条子任务",
    parameters: Type.Object({
      title: Type.String({ description: "任务标题" }),
      description: Type.Optional(Type.String({ description: "任务描述" })),
      assignedAgentId: Type.Optional(Type.String({ description: "负责角色 id（默认自己）" })),
      parentTaskId: Type.Optional(Type.String({ description: "父任务 id" })),
    }),
    execute: async (_toolCallId, params) => {
      // 去重：按 title 归一化判断是否已存在同名任务，避免 leader 重复建任务污染 DAG
      const normalizedTitle = params.title.trim().replace(/\s+/g, "");
      const dup = options.existingTasks.find(
        (t) => t.title.trim().replace(/\s+/g, "") === normalizedTitle,
      );
      if (dup) {
        return {
          content: text(`任务「${params.title}」已存在（${dup.id}），无需重复创建。`),
          details: { ok: true, kind: "create_task", deduped: true, taskId: dup.id },
        };
      }
      const error = collect({
        kind: "create_task",
        title: params.title,
        description: params.description,
        assignedAgentId: params.assignedAgentId,
        parentTaskId: params.parentTaskId,
      });
      return {
        content: text(error ?? `已创建子任务：${params.title}`),
        details: { ok: !error, kind: "create_task", deduped: false, taskId: "" },
      };
    },
  });

  const completeTask = defineTool({
    name: "team_complete_task",
    label: "完成任务",
    description: "将一条任务标记为完成（仅限本 run 内的任务）。",
    promptSnippet: "team_complete_task 完成任务",
    parameters: Type.Object({
      taskId: Type.String({ description: "任务 id（如 TASK-001）" }),
    }),
    execute: async (_toolCallId, params) => {
      const error = collect({ kind: "complete_task", taskId: params.taskId });
      return {
        content: text(error ?? `任务 ${params.taskId} 已标记完成`),
        details: { ok: !error, kind: "complete_task" },
      };
    },
  });

  const addArtifact = defineTool({
    name: "team_add_artifact",
    label: "声明产物",
    description: "声明一个工作产物（文件/目录/URL/commit），记录到项目产物清单供其他角色验证。",
    promptSnippet: "team_add_artifact 声明产物路径",
    promptGuidelines: ["产物必须是真实路径；完成后用 read 验证再声明。"],
    parameters: Type.Object({
      path: Type.String({ description: "产物路径（相对项目目录或绝对路径）" }),
      type: Type.Optional(Type.Union([
        Type.Literal("file"),
        Type.Literal("directory"),
        Type.Literal("url"),
        Type.Literal("commit"),
      ], { description: "产物类型（默认 file）" })),
      description: Type.Optional(Type.String({ description: "产物说明" })),
    }),
    execute: async (_toolCallId, params) => {
      const error = collect({
        kind: "add_artifact",
        path: params.path,
        type: params.type ?? "file",
        description: params.description,
      });
      return {
        content: text(error ?? `已声明产物：${params.path}`),
        details: { ok: !error, kind: "add_artifact" },
      };
    },
  });

  const recordDecision = defineTool({
    name: "team_record_decision",
    label: "记录决策",
    description: "记录一条关键决策（含决策人，可审计）。",
    promptSnippet: "team_record_decision 记录关键决策",
    parameters: Type.Object({
      content: Type.String({ description: "决策内容与理由" }),
      relatedTaskId: Type.Optional(Type.String({ description: "关联任务 id" })),
      verdict: Type.Optional(Type.Union([
        Type.Literal("pass"),
        Type.Literal("fail"),
        Type.Literal("info"),
      ], { description: "结构化裁决：pass=通过（质检类角色验证通过） fail=失败（发现缺陷需返工） info=中性（仅记录）" })),
    }),
    execute: async (_toolCallId, params) => {
      const error = collect({
        kind: "record_decision",
        content: params.content,
        relatedTaskId: params.relatedTaskId,
        verdict: params.verdict,
      });
      return {
        content: text(error ?? "已记录决策"),
        details: { ok: !error, kind: "record_decision" },
      };
    },
  });

  return [handoff, createTask, completeTask, addArtifact, recordDecision];
}

/** 消费 sink：把请求转成对应的事件（由 Runtime 调用，保证单写者） */
export function consumeToolRequests(
  sink: TeamToolSink,
  executionId: string,
  agentId: string,
  runId: string,
  emit: (event: unknown) => void,
): { handoff?: TeamToolRequest & { kind: "handoff" }; taskRequests: number; artifactRequests: number; decisionRequests: number; lastVerdict?: "pass" | "fail" | "info" } {
  let handoff: (TeamToolRequest & { kind: "handoff" }) | undefined;
  let taskRequests = 0;
  let artifactRequests = 0;
  let decisionRequests = 0;
  let lastVerdict: "pass" | "fail" | "info" | undefined;

  for (const req of sink.requests) {
    switch (req.kind) {
      case "handoff":
        handoff = req;
        break;
      case "create_task":
        taskRequests++;
        emit({ type: "task_created", task: buildTask(req, runId, agentId) });
        break;
      case "complete_task":
        emit({ type: "task_completed", taskId: req.taskId });
        break;
      case "add_artifact":
        artifactRequests++;
        emit({
          type: "artifact_produced",
          artifact: {
            id: `art-${executionId}-${artifactRequests}`,
            path: req.path,
            type: req.type ?? "file",
            description: req.description,
            createdBy: agentId,
            createdAt: Date.now(),
            producedByExecutionId: executionId,
          },
        });
        break;
      case "record_decision":
        decisionRequests++;
        if (req.verdict) lastVerdict = req.verdict;
        emit({
          type: "decision_recorded",
          decision: {
            id: `dec-${executionId}-${decisionRequests}`,
            content: req.content,
            madeBy: agentId,
            createdAt: Date.now(),
            relatedTaskId: req.relatedTaskId,
            verdict: req.verdict,
          },
        });
        break;
    }
  }
  return { handoff, taskRequests, artifactRequests, decisionRequests, lastVerdict };
}

let taskSeq = 0;
function buildTask(req: Extract<TeamToolRequest, { kind: "create_task" }>, runId: string, agentId: string): TeamTask {
  taskSeq += 1;
  return {
    id: `TASK-${String(taskSeq).padStart(3, "0")}`,
    runId,
    createdBy: agentId,
    title: req.title,
    description: req.description ?? "",
    assignedAgentId: req.assignedAgentId ?? agentId,
    status: "pending",
    parentTaskId: req.parentTaskId,
    createdAt: Date.now(),
  };
}

export type { AgentDef };
