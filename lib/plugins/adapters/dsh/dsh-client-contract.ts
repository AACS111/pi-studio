/**
 * DSH Client Plugin Contract — 浏览器端（client）插件契约。
 *
 * 实证来源（npm registry / unpkg 源码）：
 *   @linxin666/dsh-client-ui-task-board@0.1.18
 *   @deepseek-ai/dsh-client-runtime@0.0.1-rc.1
 *   @deepseek-ai/dsh-client-connection@0.0.1-rc.1
 *   @deepseek-ai/dsh-client-ui-settings@0.0.1-rc.1
 *
 * 关键事实：
 *   1. DSH client 插件是「浏览器端 Cordis 插件」——`exports["./client"]` 的
 *      lib/client.js 通过 `window.__ModuleLoader__.load({id, factory})` 注册，
 *      factory 里 `require()` 解析 react / @deepseek-ai/dsh-client-runtime/client
 *      等依赖，最终导出 `{ apply, inject }`（与 host 侧插件同形）。
 *   2. package.json 的 `dsh.client` manifest 声明它依赖哪些 **client 服务包**
 *      （npm 名，如 @deepseek-ai/dsh-client-runtime）；插件导出里的 `inject`
 *      声明依赖哪些 **client 服务名**（slots/sessions/workspaces/...）。
 *      服务包在浏览器端 provide 这些服务，服务实现背后是 DSH host 的
 *      session store / workspaces / agentPresets API（经 connection.api）。
 *   3. 因此 Pi 适配 = 提供这些 client 服务的 **Pi 实现**（映射到 Pi 的
 *      session / worktree / settings / i18n / UI Extension Point），而不是
 *      再实现一个 DSH Web GUI。这就是 DSH_CLIENT_SEAM_MAP 那张映射表。
 */

/** 本契约针对的 DSH client runtime 版本。 */
export const DSH_CLIENT_CONTRACT_VERSION = "0.0.1-rc.1" as const;

/** package.json 的 `dsh.client` 字段。 */
export interface DshClientManifest {
  /** 依赖的 client 服务包 npm 名。 */
  inject?: string[];
  /** 通常 "web"。 */
  platform?: string;
  /** 可选显式 client 入口（缺省用 exports["./client"]）。 */
  entry?: string;
  /** 启动即加载（不等用户触发）。 */
  immediately?: boolean;
}

/** client 插件导出（浏览器端 Cordis 插件，与 host 侧三形态同构）。 */
export interface DshClientEntry {
  apply(ctx: unknown, config?: unknown): unknown;
  inject: string[];
}

/**
 * client.js 里 `inject` 声明会用到的 client 服务名（ctx 上的服务）。
 * 实证自 dsh-client-ui-task-board 的 inject 数组 + 各 client 服务包的类型。
 */
export const DSH_CLIENT_SERVICES = [
  "slots", //        SlotsService：ctx.slots.inject(name, factory) / register(descriptor, Component)
  "sessions", //     SessionsService：ctx.sessions.list / binding(id) / open(id)
  "workspaces", //   WorkspacesService：ctx.workspaces.list / connectWorkspace(id)
  "connection", //   ConnectionService：ctx.connection.api.*（host RPC 代理）
  "settingsScope", // SettingsScope：ctx.settingsScope.bind({namespace}).getSnapshot/subscribe
  "locale", //       LocaleService：ctx.locale.register(ns, dict)
  "remote", //       RemoteService：移动端远程
  "webUiSettings", // Web UI 设置（settingsScope 的别名形态）
  "typertRegistry", // prompt 模板注册表
  "schemaForm", //    schemastery 设置表单
] as const;

/**
 * client 服务包（dsh.client.inject 里的 npm 名）→ 其提供的 client 服务名。
 * 用于兼容性报告：一个 client 插件依赖哪些服务包，进而需要哪些 Pi 能力。
 */
export const DSH_CLIENT_SERVICE_PACKAGES: Record<string, string[]> = {
  "@deepseek-ai/dsh-client-runtime": ["slots", "sessions", "workspaces"],
  "@deepseek-ai/dsh-client-connection": ["connection"],
  "@deepseek-ai/dsh-client-ui-settings": ["settingsScope", "webUiSettings"],
  "@deepseek-ai/dsh-client-ui-slots": ["slots"],
  "@deepseek-ai/dsh-client-schema-form": ["schemaForm"],
  "@deepseek-ai/dsh-typert-registry": ["typertRegistry"],
};

/**
 * DSH client seam → Pi 实现映射表（用户定义的兼容层核心资产）。
 * 每一行：DSH client 插件通过 ctx.<seam> 用到的能力，在 Pi Studio 里的落地。
 */
export const DSH_CLIENT_SEAM_MAP: Record<string, string> = {
  slots: "Pi UI Extension Slots（lib/plugins/ui/ui-registry.ts）",
  sessions: "Pi Session Store（/api/sessions）",
  workspaces: "Pi Workspace Store（/api/worktrees）",
  connection: "Pi Runtime Connection（/api/* RPC）",
  settingsScope: "Pi Settings（settings.json / storage-config）",
  locale: "Pi i18n（lib/i18n）",
  remote: "Pi Remote/IPC（Electron bridge）",
  webUiSettings: "Pi Settings（settings.json）",
  typertRegistry: "Pi prompt 模板注册表",
  schemaForm: "Pi 设置表单（schemastery 兼容）",
};

/** window.__ModuleLoader__ 协议（DSH Web GUI 的模块加载器）。 */
export interface DshModuleLoaderModule {
  id: string;
  factory: (require: (specifier: string) => unknown) => unknown;
}

export interface DshModuleLoader {
  load(module: DshModuleLoaderModule): void;
}
