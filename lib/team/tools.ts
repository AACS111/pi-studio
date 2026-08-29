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
import { mkdirSync, writeFileSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { listNotes, readNote, writeNote } from "./blackboard.ts";
import { listMemoryNotes, readMemoryNote } from "./memory.ts";
import type { AgentDef, ArtifactRef, PlanSubmissionTask, PlanTask, TeamDef, TeamTask } from "./types.ts";

/** 协议终态：to=__end__ 表示「整个任务交付完成，结束本次运行」。它不是团队角色，
 *  但必须允许出现在 team_handoff(to) 里——Runtime 的路由引擎据其终结 run。
 *  此前工具校验把它当不存在的角色拒绝，导致角色按提示词调用永远失败、
 *  只能靠 keyword 边/hybrid 兜底「碰巧」收敛（无限 ping-pong 的根因之一）。 */
export const TEAM_END_NODE = "__end__";

/** 受控工具请求（合法调用才会进入 sink） */
export type TeamToolRequest =
  | { kind: "handoff"; to: string; summary: string; artifacts?: string[]; blockers?: string[] }
  | { kind: "create_task"; title: string; description?: string; assignedAgentId?: string; parentTaskId?: string }
  | { kind: "complete_task"; taskId: string }
  | { kind: "add_artifact"; path: string; type?: ArtifactRef["type"]; description?: string }
  | { kind: "record_decision"; content: string; relatedTaskId?: string; verdict?: "pass" | "fail" | "info" }
  | { kind: "plan"; tasks: PlanSubmissionTask[] };

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
  /** DAG 编排：planner 模式（入口角色的计划轮）→ 额外注入 team_submit_plan 工具。
   *  仅 planner 可见；普通执行不提供，避免中途改计划破坏调度确定性。 */
  plannerMode?: boolean;
  /** 团队黑板（L2 上下文共享）：提供时注入 team_note_write/read/list 三件套。
   *  缺省不注入（兼容旧测试/无 run 场景）。 */
  notes?: { teamSessionId: string; runId: string };
}

function text(content: string) {
  return [{ type: "text" as const, text: content }];
}

/** 文档写工具的路径校验结果 */
export function checkDocWritePath(cwd: string, rawPath: string): { ok: true; abs: string } | { ok: false; error: string } {
  const p = String(rawPath ?? "").trim();
  if (!p) return { ok: false, error: "错误：缺少文件路径。" };
  if (!/\.(?:md|markdown|mdx)$/i.test(p)) {
    return { ok: false, error: `错误：本角色只有「文档写权限」（writePolicy=docs），只允许写 .md/.markdown 文档；拒绝写 "${p}"。业务代码请通过 team_handoff 交接给开发角色。` };
  }
  const abs = isAbsolute(p) ? resolve(p) : resolve(join(cwd, p));
  const rel = relative(resolve(cwd), abs);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("node_modules")) {
    return { ok: false, error: `错误：路径超出项目工作目录（${cwd}），拒绝写入：${p}` };
  }
  return { ok: true, abs };
}

/** DAG 计划上限：超过说明计划太碎，应合并（每次执行都是真实 token 开销） */
export const PLAN_MAX_TASKS = 12;

/** 计划提交纯校验（不落盘）：角色存在、依赖引用存在且无环、数量上限。
 *  返回规范化后的 PlanTask[]（补齐空 dependsOn）或错误文本。 */
export function validatePlanSubmission(
  team: Pick<TeamDef, "agents">,
  rawTasks: PlanSubmissionTask[],
): { ok: true; tasks: PlanTask[] } | { ok: false; error: string } {
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) return { ok: false, error: "错误：计划为空，至少需要 1 个任务。" };
  if (rawTasks.length > PLAN_MAX_TASKS) {
    return { ok: false, error: `错误：任务数 ${rawTasks.length} 超过上限 ${PLAN_MAX_TASKS}——请合并粒度过细的任务（每次执行都是真实 token 开销）。` };
  }
  const tasks: PlanTask[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawTasks.length; i++) {
    const t = rawTasks[i] ?? {};
    const title = typeof t.title === "string" ? t.title.trim() : "";
    if (!title) return { ok: false, error: `错误：第 ${i + 1} 个任务缺少 title。` };
    const agentId = typeof t.agentId === "string" ? t.agentId.trim() : "";
    if (!team.agents.some((a) => a.id === agentId)) {
      return { ok: false, error: `错误：任务「${title}」的 agentId "${agentId}" 不存在。可用角色：${team.agents.map((a) => a.id).join(", ")}` };
    }
    let id = `T${i + 1}`;
    while (seenIds.has(id)) id += `x`; // 极端重名防御（正常自增不会撞）
    seenIds.add(id);
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    tasks.push({
      id,
      title,
      agentId,
      dependsOn: deps.map(String),
      expectedOutput: typeof t.expectedOutput === "string" ? t.expectedOutput.trim() || undefined : undefined,
    });
  }
  // 依赖引用存在性 + 无环（拓扑检测：Kahn）+ 无自依赖
  for (const t of tasks) {
    if (t.dependsOn.includes(t.id)) return { ok: false, error: `错误：任务「${t.title}」依赖自身。` };
    for (const d of t.dependsOn) {
      if (!seenIds.has(d)) return { ok: false, error: `错误：任务「${t.title}」的依赖 "${d}" 不在计划中。可用任务编号：${[...seenIds].join(", ")}` };
    }
  }
  const indeg = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const queue = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  let visited = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    visited++;
    for (const t of tasks) {
      if (t.dependsOn.includes(cur)) {
        indeg.set(t.id, indeg.get(t.id)! - 1);
        if (indeg.get(t.id) === 0) queue.push(t.id);
      }
    }
  }
  if (visited !== tasks.length) {
    const stuck = tasks.filter((t) => (indeg.get(t.id) ?? 0) > 0).map((t) => t.title).slice(0, 4);
    return { ok: false, error: `错误：计划存在循环依赖，涉及：${stuck.join("、")}${stuck.length >= 4 ? "等" : ""}。请消除环后再提交。` };
  }
  return { ok: true, tasks };
}

/** 受控写工具（writePolicy=docs 角色专用）：替代内置 write，仅允许写 .md 文档且必须在项目 cwd 内。
 *  工具名保持 write —— pi 会话的 tool_execution_start 变更采集按名字识别，改动文件卡片照常显示。 */
export function createDocWriteTool(cwd: string): ToolDefinition {
  return defineTool({
    name: "write",
    label: "写入 Markdown 文档",
    description:
      "将内容写入 Markdown（.md）文档（方案/报告/说明）。本角色是文档写权限：只能写 .md 文件且必须位于项目工作目录内；业务代码（.java/.vue/.ts 等）禁止由本角色修改，请用 team_handoff 交接给开发角色。",
    promptSnippet: "write 只能写 .md 文档；改代码请交接给开发角色",
    parameters: Type.Object({
      path: Type.String({ description: "目标 .md 文件路径（绝对路径或相对项目 cwd）" }),
      content: Type.String({ description: "完整写入内容（整文件覆盖）" }),
    }),
    execute: async (_toolCallId, params) => {
      const check = checkDocWritePath(cwd, params.path);
      if (!check.ok) return { content: text(check.error), details: { ok: false } };
      try {
        mkdirSync(resolve(check.abs, ".."), { recursive: true });
        writeFileSync(check.abs, params.content ?? "", "utf8");
        return { content: text(`已写入 ${check.abs}（${(params.content ?? "").length} 字符）`), details: { ok: true } };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: text(`写入失败：${msg}`), details: { ok: false } };
      }
    },
  });
}

/** 校验并记录一次工具请求；非法时返回错误文本，合法返回 null */
function validateAndCollect(
  options: CreateTeamToolsOptions,
  request: TeamToolRequest,
): string | null {
  const { team, executingAgentId, sink } = options;

  if (request.kind === "handoff") {
    // to=__end__ 是协议终态而非角色：跳过角色存在性/handoff 策略校验，直接放行进 sink
    // （resolveRoute 的 kind=tool → END_NODE 分支负责把 run 收敛为完成）。
    if (request.to !== TEAM_END_NODE) {
      const target = team.agents.find((a) => a.id === request.to);
      if (!target) {
        return `错误：目标角色 "${request.to}" 不存在。可用角色：${team.agents.map((a) => a.id).join(", ")}（若任务已全部完成可填 "__end__" 结束运行）`;
      }
      const agent = team.agents.find((a) => a.id === executingAgentId);
      const policy = agent?.handoffPolicy;
      if (!policy?.allowSelfHandoff && request.to === executingAgentId) {
        return `错误：不能交接给自己（${executingAgentId}）。请选择其他角色或结束流程。`;
      }
      if (policy?.allowedTargets && policy.allowedTargets.length > 0 && !policy.allowedTargets.includes(request.to)) {
        return `错误：角色 ${executingAgentId} 只允许交接给：${policy.allowedTargets.join(", ")}`;
      }
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
  // 抬高任务编号下限到现有任务的最大编号（含 Runtime 创建的根任务 TASK-001），防止新建任务撞号
  raiseTaskSeqFloor(options.existingTasks);
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
      const successText =
        params.to === TEAM_END_NODE
          ? `已记录「结束运行」请求。请紧接着用纯文本输出面向用户的最终交付总结（这段文本将作为你的群聊消息展示给用户）。`
          : `已交接给 ${params.to}。摘要：${params.summary.slice(0, 120)}${params.artifacts?.length ? `（产物：${params.artifacts.join(", ")}）` : ""}`;
      return {
        content: text(error ?? successText),
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

  const tools: ToolDefinition[] = [handoff, createTask, completeTask, addArtifact, recordDecision];

  // 团队黑板（L2 主动共享层）：结构化笔记直接读写 run 目录文件（同步返回，不走 sink——
  // 读笔记必须即时可见）。跨角色的关键发现/接口约定无损传递，替代窄带摘要的 160 字符截断。
  if (options.notes) {
    const { teamSessionId, runId } = options.notes;
    const author = options.team.agents.find((a) => a.id === options.executingAgentId)?.name ?? options.executingAgentId;
    tools.push(
      defineTool({
        name: "team_note_write",
        label: "写共享笔记",
        description: "把本执行的关键发现/接口约定/踩坑写入团队黑板（本 run 内全部角色可读）。同 key 覆盖。交接前应把下游需要知道的内容写进来。",
        promptSnippet: "team_note_write 把关键发现写入团队黑板",
        parameters: Type.Object({
          key: Type.String({ description: "笔记主题名，如 api-conventions、auth-flow、pitfalls（小写短横线）" }),
          content: Type.String({ description: "笔记正文（Markdown，建议 ≤2000 字符：结论优先、文件路径/行号具体）" }),
        }),
        execute: async (_toolCallId, params) => {
          try {
            const { key } = writeNote(teamSessionId, runId, params.key, params.content, author);
            return { content: text(`已写入黑板「${key}」`), details: { ok: true, kind: "note_write", key } };
          } catch (error) {
            return { content: text(error instanceof Error ? error.message : String(error)), details: { ok: false, kind: "note_write", key: params.key } };
          }
        },
      }),
      defineTool({
        name: "team_note_read",
        label: "读共享笔记",
        description: "按 key 读取一条团队黑板笔记全文（其他角色写的发现/约定）。",
        promptSnippet: "team_note_read 按需读取黑板笔记全文",
        parameters: Type.Object({
          key: Type.String({ description: "笔记主题名（见上下文里的黑板索引）" }),
        }),
        execute: async (_toolCallId, params) => {
          const runNote = readNote(teamSessionId, runId, params.key);
          // 跨 run 记忆回退：本 run 没有时读团队级长期笔记（历史 run 晋升沉淀）
          const memNote = runNote ? null : readMemoryNote(teamSessionId, params.key);
          const note = runNote ?? memNote;
          if (!note) {
            return { content: text(`黑板里没有「${params.key}」。用 team_note_list 查看现有笔记。`), details: { ok: false, kind: "note_read" } };
          }
          return {
            content: text(`${memNote ? "〔跨run记忆〕" : ""}【${note.key}】作者：${note.author}｜更新：${note.updatedAt}\n\n${note.content}`),
            details: { ok: true, kind: "note_read" },
          };
        },
      }),
      defineTool({
        name: "team_note_list",
        label: "列黑板笔记",
        description: "列出团队黑板的全部笔记（key/作者/首行摘要），按需 team_note_read 全文。",
        promptSnippet: "team_note_list 查看黑板现有笔记",
        parameters: Type.Object({}),
        execute: async () => {
          const notes = listNotes(teamSessionId, runId);
          // 跨 run 长期笔记（排除本 run 已存在的同 key：run 内版本更新，以 run 为准）
          const runKeys = new Set(notes.map((n) => n.key));
          const memNotes = listMemoryNotes(teamSessionId)
            .filter((n) => !runKeys.has(n.key))
            .map((n) => ({ ...n, memory: true as const }));
          if (notes.length === 0 && memNotes.length === 0) return { content: text("黑板为空（尚无笔记）。"), details: { ok: true, kind: "note_list" } };
          const lines = notes.map((n) => `- ${n.key}（${n.author}，${n.updatedAt.slice(0, 16).replace("T", " ")}）：${n.summary}`);
          const memLines = memNotes.map((n) => `- ${n.key}〔跨run〕（${n.author}，${n.updatedAt.slice(0, 16).replace("T", " ")}）：${n.summary}`);
          const total = notes.length + memNotes.length;
          const body = [...lines, ...memLines].join("\n");
          return { content: text(`黑板共 ${total} 条${memNotes.length ? `（含 ${memNotes.length} 条跨run长期笔记）` : ""}：\n${body}`), details: { ok: true, kind: "note_list" } };
        },
      }),
    );
  }

  // DAG 编排：planner 轮次专用的计划提交工具（校验：角色存在/依赖引用/无环/数量上限）
  if (options.plannerMode) {
    tools.push(
      defineTool({
        name: "team_submit_plan",
        label: "提交执行计划",
        description:
          "把用户任务拆解为任务计划并一次性提交（整个团队后续按此计划自动调度执行）。每个任务指明负责角色、依赖与验收标准；无依赖关系的任务会被并行执行。提交后调度器立即开始派发，不能再修改计划。",
        promptSnippet: "team_submit_plan 一次性提交全部任务计划（含依赖关系），由调度器自动派发",
        promptGuidelines: [
          "任务人数由问题本身决定，宁少勿溢：小改动用一个全能型角色闭环；只有真正独立、可并行的子问题才拆给不同角色。禁止为了凑满团队而派活。",
          "每个任务的 expectedOutput 必须写成『变更档案』格式：改哪些文件（含路径）、动到哪些函数/行号区间、接口/传参怎么变、如何验证——让接手的角色能定点跳转而不是重新探索代码库。",
          "dependsOn 引用其它任务的编号；没有依赖的任务会并行执行，不要乱加依赖。",
        ],
        parameters: Type.Object({
          tasks: Type.Array(
            Type.Object({
              title: Type.String({ description: "任务标题" }),
              agentId: Type.String({ description: "负责角色的 id" }),
              dependsOn: Type.Optional(Type.Array(Type.String(), { description: "前置任务编号列表，如 [\"T1\"]" })),
              expectedOutput: Type.Optional(Type.String({ description: "验收标准+变更档案：改哪些文件/函数/行号、接口约定、验证方法" })),
            }),
            { description: `全部任务（最多 ${PLAN_MAX_TASKS} 个）` },
          ),
        }),
        execute: async (_toolCallId, params) => {
          const verdict = validatePlanSubmission(options.team, params.tasks);
          if (!verdict.ok) {
            return { content: text(verdict.error + " 请修正后重新调用本工具提交。"), details: { ok: false } };
          }
          const err = collect({ kind: "plan", tasks: params.tasks });
          const list = verdict.tasks.map((t) => `${t.id}[${t.agentId}]${t.dependsOn.length ? `←${t.dependsOn.join(",")}` : ""} ${t.title}`).join("；");
          return {
            content: text(err ?? `计划已接受（${verdict.tasks.length} 个任务）：${list}。请用纯文本输出一句面向用户的计划说明（即将开始自动执行）。`),
            details: { ok: !err },
          };
        },
      }),
    );
  }
  return tools;
}

/** 消费 sink：把请求转成对应的事件（由 Runtime 调用，保证单写者） */
export function consumeToolRequests(
  sink: TeamToolSink,
  executionId: string,
  agentId: string,
  runId: string,
  emit: (event: unknown) => void,
): { handoff?: TeamToolRequest & { kind: "handoff" }; taskRequests: number; artifactRequests: number; decisionRequests: number; lastVerdict?: "pass" | "fail" | "info"; lastDecisionContent?: string; planRequest?: { tasks: PlanSubmissionTask[] } } {
  let handoff: (TeamToolRequest & { kind: "handoff" }) | undefined;
  let taskRequests = 0;
  let artifactRequests = 0;
  let decisionRequests = 0;
  let lastVerdict: "pass" | "fail" | "info" | undefined;
  let lastDecisionContent: string | undefined;
  let planRequest: { tasks: PlanSubmissionTask[] } | undefined;

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
        lastDecisionContent = req.content;
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
      case "plan":
        planRequest = { tasks: req.tasks };
        break;
    }
  }
  return { handoff, taskRequests, artifactRequests, decisionRequests, lastVerdict, lastDecisionContent, planRequest };
}

/** 任务编号序列（模块级单调递增，跨执行器实例防并发撞号）。
 *  createTeamTools 每次创建时会把 existingTasks 中的最大编号提升为下限：
 *  根任务 TASK-001 由 Runtime 创建，若不抬底，角色自建的第一个任务也会拿到
 *  TASK-001 与根任务撞车；同理同进程多个 run 之间编号也可回退。 */
let taskSeq = 0;
function raiseTaskSeqFloor(existingTasks: TeamTask[]): void {
  for (const t of existingTasks) {
    const m = /^TASK-(\d+)$/.exec(t.id);
    if (m) taskSeq = Math.max(taskSeq, Number(m[1]));
  }
}
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
