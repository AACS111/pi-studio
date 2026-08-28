/**
 * P1-4：LLM judge 结构化落地（真实判定器）。
 *
 * 背景：engine.ts 的 WorkflowEngine 支持 `Transition.trigger.condition.mode === "llm"`
 * 作为「最后决策器」，但此前只有测试 mock——生产注册表（registry.ts）从未传入 llmJudge，
 * llm 条件在实际运行中永不命中（安全降级为 keyword 路由）。
 *
 * 本模块提供真实实现，三个关键设计：
 *  1. **结构化作答**：不问自由文本问题，而是列出编号候选边，要求模型只回
 *     `{"choice": <编号>}`（0 = 都不命中）。解析严格校验编号范围，非法/越界/解析失败
 *     一律按「不命中」处理——LLM 判定只允许在结构化空间内出错，不给幻觉文本进路由的机会。
 *  2. **安全降级**：判定器任何环节失败（无可用模型/无认证/超时/抛错）都返回 null，
 *     路由回落到 keyword/always 层，与「未提供 judge」行为完全一致。绝不 throw 砸掉 run。
 *  3. **成本可控**：每次路由决策最多一次调用（engine 层保证）；temperature 0、
 *     reasoning minimal、maxTokens 收紧、cacheRetention none、20s 超时、0 重试。
 *
 * 模型选择：env `PI_TEAM_LLM_JUDGE_MODEL=provider/modelId` 覆盖 > 设置默认模型 >
 * 首个可见模型（可见域复用 lib/model-scope 的 enabledModels 解析，与 UI 一致）。
 * 开关：env `PI_TEAM_LLM_JUDGE=0` 关闭（createLlmJudge 返回 undefined，回到旧行为）。
 */
import {
  createAgentSessionServices,
  getAgentDir,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { resolveVisibleModels, selectInitialModelScope } from "../model-scope.ts";
import { projectTrustReloadOptions } from "../project-trust.ts";
import { stripNoise } from "./validate.ts";
import type { LlmJudge } from "./engine.ts";
import type { Condition, Transition } from "./types.ts";

/** 判定器后端抽象：真实实现走 ModelRuntime+completeSimple；测试注入 mock。 */
export interface JudgeBackend {
  ask(input: { system: string; user: string; signal: AbortSignal }): Promise<string>;
}

export const JUDGE_SYSTEM_PROMPT = [
  "你是软件团队工作流的路由裁判。给你一位角色刚完成工作的输出节选，以及若干条候选流转边",
  "（编号 1..N，每条含目标角色与命中条件）。你的唯一任务：判断角色输出最符合哪一条候选边的条件。",
  '只输出一个 JSON 对象：{"choice": 编号}。0 表示没有任何候选边命中。',
  "禁止输出解释、前后缀、markdown 代码块或其他任何字段。",
].join("\n");

/** 描述单条候选边的命中条件（供判定提示词与测试）。 */
export function describeCondition(cond: Condition | undefined): string {
  if (!cond || cond.mode === "always") return "无条件命中";
  if (cond.mode === "keyword") {
    const parts: string[] = [];
    if (cond.keywords?.length) parts.push(`输出包含「${cond.keywords.join("、")}」任一关键词`);
    if (cond.rejectKeywords?.length) parts.push(`但包含「${cond.rejectKeywords.join("、")}」任一关键词则不命中`);
    return parts.length ? parts.join("，") : "无条件命中";
  }
  return cond.conditionText?.trim() || "由你判断该条件是否命中";
}

/** 构建判定 user message：编号候选边 + 角色输出节选。
 *  describeTarget：可选的目标节点释义（如「fe-developer（前端开发）」），由调用方注入团队角色上下文。 */
export function buildJudgeUserMessage(
  candidates: Array<{ transition: Transition; agentOutput: string }>,
  maxOutputChars = 4000,
  describeTarget?: (to: string) => string,
): string {
  const lines = candidates.map((c, i) => {
    const cond = describeCondition(c.transition.trigger?.condition);
    const label = describeTarget?.(c.transition.to)?.trim();
    const to = label ? `${c.transition.to}（${label}）` : c.transition.to;
    return `${i + 1}. → ${to}｜条件：${cond}`;
  });
  // 输出节选：屏蔽代码块/引用块（路由只关心结论文本），截断防爆 token
  const excerpt = stripNoise(candidates[0]?.agentOutput ?? "").trim();
  const body = excerpt.length > maxOutputChars
    ? `${excerpt.slice(0, Math.floor(maxOutputChars * 0.7))}\n……[中间省略]……\n${excerpt.slice(-Math.floor(maxOutputChars * 0.3))}`
    : excerpt;
  return [
    "## 候选流转边",
    ...lines,
    "",
    "## 角色输出（节选）",
    '"""',
    body || "（无文本输出）",
    '"""',
    "",
    '只输出 {"choice": 编号}（都不命中则输出 {"choice": 0}）。',
  ].join("\n");
}

/**
 * 解析判定应答为候选编号（0 = 都不命中；null = 解析失败/越界）。
 * 解析顺序：首个 {...} JSON 的 choice 字段 → 裸数字兜底。
 * JSON 存在但 choice 非法/越界 → 直接 null（不回退裸数字，避免把「编号 12」猜成 1）。
 */
export function parseJudgeChoice(raw: string, max: number): number | null {
  if (!raw) return null;
  const text = raw.trim();
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { choice?: unknown };
      const v = parsed.choice;
      const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v, 10) : Number.NaN;
      if (Number.isInteger(n) && n >= 0 && n <= max) return n;
      return null;
    } catch {
      /* JSON 破损 → 裸数字兜底 */
    }
  }
  const m = text.match(/(?:^|[^\w"])(\d{1,3})(?:[^\w"]|$)/);
  if (m) {
    const n = Number.parseInt(m[1]!, 10);
    if (n >= 0 && n <= max) return n;
  }
  return null;
}

/** —— 服务缓存（cwd 维度）：AgentSessionServices 构建较重，进程内复用 —— */
const servicesCache = new Map<string, Promise<AgentSessionServices | null>>();

/** 测试/设置变更后重置服务缓存。 */
export function resetLlmJudgeServices(): void {
  servicesCache.clear();
}

function getServices(cwd: string): Promise<AgentSessionServices | null> {
  let p = servicesCache.get(cwd);
  if (!p) {
    p = (async () => {
      try {
        const agentDir = getAgentDir();
        // 与 /api/models 相同的项目信任闸门：不给未信任项目的扩展执行机会
        const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
        return await createAgentSessionServices({
          cwd,
          agentDir,
          ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
        });
      } catch {
        return null;
      }
    })();
    servicesCache.set(cwd, p);
  }
  return p;
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** 解析 env 覆盖的 "provider/modelId"（缺 provider 视为空 provider=默认域）。 */
function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const idx = trimmed.indexOf("/");
  if (idx > 0) return { provider: trimmed.slice(0, idx), modelId: trimmed.slice(idx + 1) };
  return { provider: "", modelId: trimmed };
}

/** 构建默认后端：解析当前默认模型 → completeSimple 单次调用。
 *  任何一步失败返回 null（调用方安全降级为无 judge）。 */
export async function createDefaultBackend(cwd: string): Promise<JudgeBackend | null> {
  const services = await getServices(cwd);
  if (!services) return null;
  try {
    const settings = services.settingsManager;
    const runtime = services.modelRuntime;
    const scope = await resolveVisibleModels(runtime, settings.getEnabledModels());
    if (scope.visible.length === 0) return null;

    // 模型优先级：env 覆盖（必须在可见域内，否则回落默认规则）> 设置默认 > 首个可见模型
    const envRef = parseModelRef(process.env.PI_TEAM_LLM_JUDGE_MODEL ?? "");
    let model = undefined as ReturnType<typeof selectInitialModelScope>["model"];
    if (envRef) {
      try {
        model = selectInitialModelScope(scope, { requestedModel: envRef }).model;
      } catch {
        model = undefined; // env 指向不在可见域的模型 → 回落，不硬失败
      }
    }
    if (!model) {
      const dp = settings.getDefaultProvider();
      const dm = settings.getDefaultModel();
      model = selectInitialModelScope(scope, dp && dm ? { defaultModel: { provider: dp, modelId: dm } } : {}).model
        ?? scope.visible[0];
    }

    const resolved = await runtime.getAuth(model);
    if (!resolved?.auth.apiKey) return null; // 无认证 → 安全降级（keyword 路由兜底）

    return {
      ask: async ({ system, user, signal }) => {
        const message = await completeSimple(model, {
          systemPrompt: system,
          messages: [{ role: "user", content: user, timestamp: Date.now() }],
        }, {
          apiKey: resolved.auth.apiKey,
          headers: resolved.auth.headers,
          maxTokens: 800,
          temperature: 0,
          reasoning: "minimal",
          timeoutMs: 20_000,
          maxRetries: 0,
          cacheRetention: "none",
          signal,
        });
        // 模型侧错误/中止 → 空串（调用方 parseJudgeChoice 返回 null → 不命中）
        if (message.stopReason === "error" || message.stopReason === "aborted") return "";
        return getAssistantText(message);
      },
    };
  } catch {
    return null;
  }
}

export interface LlmJudgeOptions {
  /** 团队 cwd（决定模型解析与项目信任上下文；缺省 process.cwd()） */
  cwd?: string;
  /** 单次判定超时（默认 20s） */
  timeoutMs?: number;
  /** 输出节选长度上限（默认 4000 字符） */
  maxOutputChars?: number;
  /** 注入后端（测试）；缺省用真实 createDefaultBackend */
  backend?: JudgeBackend;
  /** 目标节点释义（注册表注入：把 to 映射为「角色名：职责」，提升判定质量） */
  describeTarget?: (to: string) => string;
  /** 显式禁用（测试便利；生产用 env PI_TEAM_LLM_JUDGE=0） */
  disabled?: boolean;
}

/** 创建生产用 LLM judge（engine 的最后决策器）。
 *  返回 undefined = 明确禁用（env/选项），engine 回到「无 judge」行为。
 *  返回的 judge 永不 throw：后端缺失/调用失败/解析失败一律返回 null（不命中）。 */
export function createLlmJudge(options: LlmJudgeOptions = {}): LlmJudge | undefined {
  if (options.disabled || process.env.PI_TEAM_LLM_JUDGE === "0") return undefined;
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxOutputChars = options.maxOutputChars ?? 4000;
  let backendPromise: Promise<JudgeBackend | null> | undefined;
  const getBackend = (): Promise<JudgeBackend | null> => {
    backendPromise ??= options.backend
      ? Promise.resolve(options.backend)
      : createDefaultBackend(cwd);
    return backendPromise;
  };

  return async (candidates) => {
    if (candidates.length === 0) return null;
    try {
      const backend = await getBackend();
      if (!backend) return null;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // 双保险：abort 信号（真实后端取消）+ Promise.race 超时拒绝（后端不响应 signal 也不许挂住路由）
        const raw = await Promise.race([
          backend.ask({
            system: JUDGE_SYSTEM_PROMPT,
            user: buildJudgeUserMessage(candidates, maxOutputChars, options.describeTarget),
            signal: controller.signal,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`llm judge timeout (${timeoutMs}ms)`));
            }, timeoutMs);
          }),
        ]);
        const choice = parseJudgeChoice(raw, candidates.length);
        if (!choice || choice < 1) return null; // 0 = 都不命中；null = 解析失败
        return candidates[choice - 1]?.transition ?? null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      return null;
    }
  };
}
