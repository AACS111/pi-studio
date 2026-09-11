/**
 * 计划/决策类自定义工具（server-only，不能从客户端 import）。
 *
 * `ask_user`：当实现方案有歧义、需要用户拍板时，弹出选项让用户选一条路线。
 * 工具会**阻塞**直到用户在界面上作答，然后把用户的选择作为工具结果返回给模型，
 * 模型据此继续规划/执行——对应 dsh 的 approval「ask」与 Codex 的决策点确认。
 *
 * 与 UI 的通路：pi-studio 已实现 pi 扩展 UI 协议（select / input），
 * 这里通过 PlanToolBridge 回调到 AgentSessionWrapper.requestUserChoice，
 * 复用前端既有的 ExtensionDialog，不依赖 TUI custom 组件。
 */
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MAX_PLAN_STAGES, UPDATE_PLAN_TOOL_NAME } from "./plan-mode.ts";

export const ASK_USER_TOOL_NAME = "ask_user";

/** 默认的「自己填」兜底选项文案；模型可按用户语言覆盖 */
const DEFAULT_CUSTOM_LABEL = "其他（自己填写）";

/** 单次询问等待用户作答的时长；超时则让模型按合理假设继续，避免永久卡死 */
const ASK_TIMEOUT_MS = 10 * 60 * 1000;

export interface AskUserRequest {
  method: "select" | "input";
  title: string;
  options?: string[];
  placeholder?: string;
  timeout?: number;
}

/** UI 桥：返回用户选择的文案；undefined = 取消/超时/界面不可用 */
export interface PlanToolBridge {
  ask?: (request: AskUserRequest) => Promise<string | undefined>;
}

export interface AskUserDetails {
  question: string;
  options: string[];
  answer: string | null;
  cancelled?: boolean;
}

function text(value: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: value }];
}

/**
 * 创建计划模式配套工具。bridge.ask 在 session wrapper 创建后才会被赋值，
 * 但工具 execute 只在真正被调用时读取，所以延迟绑定是安全的。
 */
export function createPlanTools(bridge: PlanToolBridge): ToolDefinition[] {
  const updatePlan = defineTool({
    name: UPDATE_PLAN_TOOL_NAME,
    label: "更新分步计划",
    description:
      "维护任务的分步计划清单（全量替换）。用于长任务/多步任务的进度跟踪：界面会实时展示清单与当前进行中的步骤。"
      + "每一步一句话、简短明确；同一时刻只能有一个 in_progress，直到全部完成。计划有变时提交新清单并在 explanation 说明原因。",
    promptSnippet: "update_plan 维护任务的分步计划（pending/in_progress/completed 实时清单）",
    promptGuidelines: [
      "长任务（大致 3 步以上）开始时，用 update_plan 建立分步计划：每步一句话、简短（不超过 5-7 个词/短句）。",
      "每完成一步，用 update_plan 把完成项标 completed、把下一步标 in_progress；同一时刻只能有一个 in_progress，直到全部完成。一次可以把多个步骤标 completed。",
      "调用 update_plan 后不要重复计划全文（界面已经展示了），只需简述这次改了什么、下一步做什么。",
      "计划中途有变时，用 update_plan 提交新计划，并在 explanation 里说明原因。",
      "全部步骤完成后，确保调用 update_plan 把所有步骤标为 completed。",
    ],
    parameters: Type.Object({
      explanation: Type.Optional(
        Type.String({ description: "仅在计划有变时填写：改了什么、为什么改" }),
      ),
      plan: Type.Array(
        Type.Object({
          step: Type.String({ description: "一步的简述（一句话）" }),
          status: Type.Union([
            Type.Literal("pending"),
            Type.Literal("in_progress"),
            Type.Literal("completed"),
          ]),
        }),
        { description: "完整步骤列表（全量替换）：pending/in_progress/completed" },
      ),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const plan = (params.plan ?? [])
        .map((item) => ({ step: (item.step ?? "").trim(), status: item.status }))
        .filter((item) => item.step.length > 0)
        .slice(0, MAX_PLAN_STAGES);
      if (plan.length === 0) {
        return { content: text("错误：update_plan 的 plan 不能为空。"), details: { plan: [] } };
      }
      const completed = plan.filter((item) => item.status === "completed").length;
      const running = plan.filter((item) => item.status === "in_progress").length;
      const summary = `已更新计划：${completed}/${plan.length} 完成${running > 0 ? "，进行中 1 项" : ""}。`;
      return {
        content: text(summary),
        details: { plan, ...(params.explanation?.trim() ? { explanation: params.explanation.trim() } : {}) },
      };
    },
  });

  const askUser = defineTool({
    name: ASK_USER_TOOL_NAME,
    label: "询问用户决策",
    description:
      "当实现方案存在真正的歧义、且用户偏好会决定走哪条路时，弹出选项让用户拍板，然后按用户选择继续。"
      + "适合：技术选型（方案 A/B）、范围取舍（改哪些/不改哪些）、命名或交互风格、破坏性改动前的确认。"
      + "不适合：有唯一合理答案的琐碎细节、能自己查代码确认的事实。一次只问一个问题，选项要具体、互斥、可直接执行。",
    promptSnippet: "ask_user 在方案有歧义、需要用户拍板时，弹选项让用户选择路线",
    promptGuidelines: [
      "遇到会改变实现方向的岔路口（技术选型 / 方案 A 与 B / 范围与兼容性取舍 / 破坏性改动）且用户偏好不明确时，用 ask_user 让用户拍板，不要自己替用户决定。",
      "ask_user 的每个选项要一句话说清『做什么 + 代价或影响』，2~5 个、互斥、可直接执行；不要给泛泛的『是/否』。",
      "低风险、有唯一合理答案的细节不要问；只在真正有歧义且影响后续工作时问，一次只问一个决策点。",
      "拿到用户选择后按该方案继续，不要就同一问题反复追问；用户若取消选择，按最保守的方案继续并在计划里注明。",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "要用户拍板的问题（一句话，点明歧义在哪）" }),
      options: Type.Array(Type.String(), {
        description: "候选方案，2~5 个，每个一句话含『做什么 + 影响』；工具会自动追加一个『自己填写』兜底选项",
      }),
      customLabel: Type.Optional(
        Type.String({ description: `『自己填写』兜底选项的文案（默认「${DEFAULT_CUSTOM_LABEL}」）` }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const question = params.question?.trim() ?? "";
      const options = (params.options ?? []).map((option) => option.trim()).filter(Boolean);
      const customLabel = params.customLabel?.trim() || DEFAULT_CUSTOM_LABEL;

      const fail = (message: string) => ({
        content: text(message),
        details: { question, options, answer: null } as AskUserDetails,
      });

      if (!question) return fail("错误：ask_user 需要 question。");
      if (options.length < 2) return fail("错误：ask_user 至少需要 2 个选项。");
      if (typeof bridge.ask !== "function") return fail("错误：当前环境不支持交互式询问，请基于合理假设继续。");

      const choice = await bridge.ask({
        method: "select",
        title: question,
        options: [...options, customLabel],
        timeout: ASK_TIMEOUT_MS,
      });
      if (choice === undefined || choice === null) {
        return {
          content: text(
            `用户未作答（取消 / 超时 / 界面不可用）。请按最保守、最不容易出错的方案继续，并在计划或回复里明确标注这一假设。`,
          ),
          details: { question, options, answer: null, cancelled: true } as AskUserDetails,
        };
      }

      let answer = choice;
      if (choice === customLabel) {
        const custom = await bridge.ask({
          method: "input",
          title: question,
          placeholder: "请输入你的方案",
          timeout: ASK_TIMEOUT_MS,
        });
        const trimmed = custom?.trim();
        if (!trimmed) {
          return {
            content: text("用户取消了自定义输入。请按最保守的方案继续，并在计划里标注这一假设。"),
            details: { question, options, answer: null, cancelled: true } as AskUserDetails,
          };
        }
        answer = trimmed;
      }

      return {
        content: text(`用户选择：${answer}`),
        details: { question, options, answer } as AskUserDetails,
      };
    },
  });

  return [updatePlan, askUser];
}
