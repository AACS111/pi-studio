/**
 * 进程内 UI 扩展注册表（挂 globalThis，防 Next 热重载丢状态 —— 同
 * rpc-manager 的 `__piSessions` / plugin-registry 的 `__piPlugins` 做法）。
 *
 * DSH client adapter 与 Pi 原生插件把「sidebar / panel / statusbar」扩展注册
 * 到这里，前端经 /api/plugins/ui 拉取渲染。
 */
import type { PiUiExtension } from "./types";

declare global {
  var __piUiExtensions: Map<string, PiUiExtension> | undefined;
}

function getRegistry(): Map<string, PiUiExtension> {
  if (!globalThis.__piUiExtensions) {
    globalThis.__piUiExtensions = new Map();
  }
  return globalThis.__piUiExtensions;
}

/** 注册（或覆盖）一个 UI 扩展。 */
export function registerUiExtension(ext: PiUiExtension): void {
  getRegistry().set(ext.id, ext);
}

/** 移除一个 UI 扩展。 */
export function unregisterUiExtension(id: string): void {
  getRegistry().delete(id);
}

/** 列出所有 UI 扩展。 */
export function listUiExtensions(): PiUiExtension[] {
  return [...getRegistry().values()];
}

/** 按插件 id 移除其所有扩展。 */
export function unregisterPluginExtensions(pluginId: string): void {
  const reg = getRegistry();
  for (const [id, ext] of reg) {
    if (ext.pluginId === pluginId) reg.delete(id);
  }
}
