/**
 * DeepSeek Harness (DSH) Plugin Contract — 版本化契约。
 *
 * 这是「DSH 是什么」的单一事实来源，只描述 DSH 运行时的事实，不掺 Pi 的实现映射
 * （映射是 dsh-adapter 的事）。全部内容来自对以下真实包的源码实证，**不是猜测**：
 *
 *   @deepseek-ai/dsh@0.1.0-rc.6            （meta/CLI，config/agent-presets + lib/bin.js）
 *   @deepseek-ai/cordis@4.0.1               （运行时：Context/Service/Registry/Fiber）
 *   @deepseek-ai/dsh-base@0.0.1-rc.1        （无代码，实体是 cordis.patch.yml）
 *   @deepseek-ai/cordis-plugin-loader@1.0.2 （profile composer 的 loader）
 *   @deepseek-ai/dsh-skill@0.0.1-rc.1       （ctx.skills：分层 SkillService + Provider）
 *   @deepseek-ai/dsh-tool-fs@0.0.1-rc.1     （inject:["tools","fs","systemPrompt"] 的 tool 插件）
 *   @deepseek-ai/dsh-fs@0.0.1-rc.1          （ctx.fs：抽象 FileSystem Service + 类型词汇）
 *   @deepseek-ai/dsh-tools@0.0.1-rc.1       （ctx.tools：ToolRegistry + defineTool）
 *   @deepseek-ai/dsh-system-prompt@0.0.1-rc.1 （ctx.systemPrompt：SystemPrompt Service）
 *
 * DSH 升级时：重新 dump 这些包，diff 本文件，按差异放行/拦截。POC 已证明
 * 真 Cordis 运行时 + Pi 能力注入成 Service，可让 dsh-tool-fs 脱离 DSH CLI 跑通。
 */

/** 本契约针对的 DSH 主包版本。 */
export const DSH_CONTRACT_VERSION = "0.1.0-rc.6" as const;

/** 底层 Cordis 运行时版本（@deepseek-ai/cordis）。 */
export const CORDIS_VERSION = "4.0.1" as const;

/**
 * DSH 插件入口的三种形态（Cordis `Plugin` 类型）。
 * - function：`(ctx, config) => any`
 * - class：    `new (ctx, config)`，实例生命周期绑定 fiber
 * - object：   `{ apply(ctx, config) }`
 */
export type DshPluginKind = "function" | "class" | "object";

/**
 * 插件元数据（Cordis `Plugin.Base`）。loader 用它驱动依赖注入与配置校验。
 */
export interface DshPluginMetadata {
  /** 展示名，用于 fiber 诊断与 logger 命名。 */
  name?: string;
  /** 依赖的服务名数组；只有全部可用时插件才加载（服务可用性驱动）。 */
  inject?: string[];
  /** 本插件提供的服务名（单个或数组）。 */
  provide?: string | string[];
  /** 配置 schema（schemastery，实现了 StandardSchemaV1）。 */
  Config?: unknown;
  /** 声明消费哪些服务的 intercept 配置。 */
  intercept?: Record<string, boolean>;
}

/**
 * 三种入口形态的完整描述（含元数据）。loadDshPlugin 会把任意形态归一化成
 * 「可执行 callback + inject/provide/Config」。
 */
export interface DshPluginFunction<T = unknown> extends DshPluginMetadata {
  (ctx: unknown, config: T): unknown;
}
export interface DshPluginConstructor<T = unknown> extends DshPluginMetadata {
  new (ctx: unknown, config: T): unknown;
}
export interface DshPluginObject<T = unknown> extends DshPluginMetadata {
  apply(ctx: unknown, config: T): unknown;
}
export type DshPlugin<T = unknown> =
  | DshPluginFunction<T>
  | DshPluginConstructor<T>
  | DshPluginObject<T>;

/**
 * 已实证的 ctx 服务名（`extends Service` 的 `super(ctx, name)` 里写的字面量）。
 * 这些是插件通过 `ctx.<name>` / `ctx.get("<name>")` 读到的能力。
 */
export const DSH_CTX_SERVICES = [
  "fs", //          @deepseek-ai/dsh-fs：FileSystem（抽象，后端实现 resolve/stat/readText/writeText/editText…）
  "tools", //       @deepseek-ai/dsh-tools：ToolRegistry.register(definition)
  "systemPrompt", // @deepseek-ai/dsh-system-prompt：SystemPrompt.section({name,order,text})
  "skills", //      @deepseek-ai/dsh-skill：SkillService（分层 Provider 注册表）
] as const;

/**
 * 从 dsh-tool-fs 代码路径里观察到的、通过 `ctx.get("<name>")` 惰性读取的服务名
 * （仅在 `ctx.fs.sandboxMode !== undefined` 即「挂载了沙箱后端」时才需要）。
 * 裸后端（Pi 的 PiFsService）不沙箱，故这些在 Phase 1 可不实现。
 */
export const DSH_LAZY_SERVICES = [
  "sandboxPolicy", // 沙箱策略解析器
  "approval", //     用户批准（沙箱升级时）
] as const;

/**
 * 从 `@deepseek-ai/dsh-base/cordis.patch.yml` 全文摘出的插件行 id（composition
 * 里的稳定引用名，不等于服务名，也常不等于 npm 包名）。用于 diff 和升级检测。
 */
export const DSH_PATCH_ROW_IDS = [
  "timer", "hmr", "llm", "session", "typert", "typert-loader", "typert-gateway",
  "session-title", "session-title-llm", "user-interaction", "agent",
  "agent-default-model", "tasks", "llm-retry", "settings", "credentials",
  "llm-pi-ai", "session-persistence-jsonl", "attachment-local",
  "session-query-sqlite", "session-projection", "telemetry-otel", "subprocess",
  "sandbox", "sandbox-policy", "bash-sandbox", "approval", "permission",
  "bash-env", "tool-bash", "tool-tasks", "fs-policy", "tool-fs",
  "tool-fs-search", "workspace-context", "skill", "skill-local", "skill-badge",
  "tool-skill", "commands", "command-feedback", "goal", "goal-session",
  "command-goal", "plan-mode", "token-meter", "compact-basic", "command-compact",
  "subagent", "subagent-spawn", "subagent-fork", "subagent-codex",
  "subagent-claude-code", "tool-subagent-control", "tool-subagent-list-agents",
  "tool-subagent", "tool-subagent-fork", "tool-subagent-report",
  "workflow-workerthread", "tool-workflow", "timeout-policy", "spill-local",
  "spill-policy", "session-checkpoint-policy", "tool-result-prune", "tool-todo",
  "tool-goal", "tool-ralph", "tool-str-replace-editor", "repeat-tool-guard",
  "web", "web-search-deepseek", "tool-web", "tools", "system-prompt",
  "agent-loop", "fs-sandbox", "llm-deepseek",
] as const;

/**
 * cordis.patch.yml 的一行（一个插件插入项）。`name` 是 npm 包名，`id` 是
 * composition 内的稳定引用，`config` 是传给插件 apply 的原始配置，
 * `disabled` 禁用该行。patch 语义：后写覆盖先写（last write wins per row），
 * 行顺序无加载语义（激活是服务可用性驱动的）。
 */
export interface DshPatchRow {
  id: string;
  name: string;
  config?: unknown;
  disabled?: boolean;
}

/**
 * cordis.patch.yml 的顶层形状：一个或多个 `- insert:` / `- id: ...` 块。
 * `insert` 是新增插件行；顶层 `id` + `disabled: true` 是禁用已有行。
 */
export interface DshPatchFile {
  insert?: DshPatchRow[];
  [rowId: string]: unknown;
}

/**
 * 包的 `dsh` manifest 字段（package.json 里），由 profile composer 解析：
 * `dsh.bundle.patch` 指向一个 cordis.patch.yml，声明该 bundle 提供的插件行。
 * 例：dsh-base 的 package.json 有
 *   "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
 */
export interface DshPackageManifest {
  /** bundle patch 路径；安装器据此读 composition。 */
  bundle?: { patch?: string };
}

/**
 * Skill 目录布局（官方 agent-presets 里的实证）：
 *   config/agent-presets/<preset>/skills/<skill-name>/SKILL.md
 * 以及各插件包内常见的 `.dsh/skills/**\/SKILL.md`。
 */
export const DSH_SKILL_LAYOUT = {
  /** skill 文件名。 */
  entry: "SKILL.md",
  /** 官方 preset 内 skills 的相对位置（主包 config/ 下）。 */
  presetSkillsDir: "config/agent-presets",
} as const;

/** 版本差异检测用的稳定导出：升级 DSH 时 diff 这些值即可。 */
export function dshContractFingerprint(): string {
  return [
    `dsh=${DSH_CONTRACT_VERSION}`,
    `cordis=${CORDIS_VERSION}`,
    `services=${DSH_CTX_SERVICES.join(",")}`,
    `rows=${DSH_PATCH_ROW_IDS.length}`,
  ].join("; ");
}
