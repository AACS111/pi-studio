/**
 * 进程内插件注册表（挂 globalThis，防 Next 热重载丢状态 —— 同 rpc-manager 的
 * `__piSessions` 做法）。
 *
 * 记录「已加载并桥接的插件」及其产物（tools / skills / compat）。DSH 生态的
 * 工具通过 `customTools` 注入 session；这里维护那份产物供 session 创建时读取。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RegisteredPlugin } from "./types";

declare global {
  var __piPlugins: Map<string, RegisteredPlugin> | undefined;
}

function getRegistry(): Map<string, RegisteredPlugin> {
  if (!globalThis.__piPlugins) {
    globalThis.__piPlugins = new Map();
  }
  return globalThis.__piPlugins;
}

/** 注册（或覆盖）一个已加载插件。 */
export function registerPlugin(plugin: RegisteredPlugin): void {
  getRegistry().set(plugin.id, plugin);
}

/** 移除一个插件。 */
export function unregisterPlugin(id: string): void {
  getRegistry().delete(id);
}

/** 列出所有已加载插件。 */
export function listPlugins(): RegisteredPlugin[] {
  return [...getRegistry().values()];
}

/** 按来源列出。 */
export function listPluginsByOrigin(origin: RegisteredPlugin["origin"]): RegisteredPlugin[] {
  return listPlugins().filter((p) => p.origin === origin);
}

/** 汇总所有已加载 DSH 插件桥接出的 pi 工具（供 session customTools 注入）。 */
export function collectDshTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const plugin of getRegistry().values()) {
    if (plugin.artifacts) tools.push(...plugin.artifacts.tools);
  }
  return tools;
}

/** 汇总所有已加载 DSH 插件识别出的 skill 目录。 */
export function collectDshSkillPaths(): string[] {
  const paths: string[] = [];
  for (const plugin of getRegistry().values()) {
    if (plugin.artifacts) paths.push(...plugin.artifacts.skillPaths);
  }
  return paths;
}
