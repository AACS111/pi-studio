/**
 * Pi Studio UI Extension Point — 类型定义。
 *
 * 这是 Pi Studio 自己的插件 UI 扩展契约：插件（无论 pi 原生还是 DSH 经
 * adapter 桥接）注册「sidebar 条目 / 面板 / 状态栏条目」，Pi 前端渲染它们。
 * 服务端只存「描述元数据」（不含 React 组件）；面板的实际内容由前端组件承载
 * （Pi 原生插件走 PluginHost 内置渲染，DSH client 插件走 dsh-client-adapter
 * 动态加载）。
 */

/** 插件来源生态。 */
export type PiUiExtensionOrigin = "pi" | "dsh" | "mcp";

/** 扩展类型。 */
export type PiUiExtensionKind = "sidebar" | "statusbar" | "panel";

/** 侧边栏条目描述（ActivityBar rail 里的一个可点击图标）。 */
export interface PiUiSidebarEntry {
  /** 稳定 id（如 `task-board`）。 */
  id: string;
  /** 显示名（tooltip / 面板标题）。 */
  label: string;
  /**
   * 图标名（内置集合，见 components/PluginHost.tsx 的 PLUGIN_ICONS）。
   * 服务端到前端不能传 ReactNode，故用名字映射。
   */
  icon?: string;
  /** 排序权重，越小越靠前。 */
  order?: number;
  /** i18n namespace（DSH client 插件自带的 locale 字典）。 */
  locale?: string;
}

/** DSH client 插件渲染所需的信息（dsh-client-adapter 填充）。 */
export interface PiUiExtensionClient {
  /** client 入口相对路径（package.json exports["./client"]）。 */
  entry: string;
  /** 依赖的 client 服务名（dsh.client.inject）。 */
  inject: string[];
  /** platform（dsh.client.platform，通常 "web"）。 */
  platform?: string;
}

/** 一个已注册的 UI 扩展。 */
export interface PiUiExtension {
  /** 扩展 id（跨插件唯一，如 `dsh:task-board`）。 */
  id: string;
  /** 所属插件 id（如 `dsh:@linxin666/dsh-client-ui-task-board`）。 */
  pluginId: string;
  origin: PiUiExtensionOrigin;
  kind: PiUiExtensionKind;
  /** 面板标题。 */
  title: string;
  description?: string;
  /** kind === "sidebar" 时必有。 */
  sidebarEntry?: PiUiSidebarEntry;
  order?: number;
  /** DSH client 插件附加的渲染信息。 */
  client?: PiUiExtensionClient;
  meta?: Record<string, unknown>;
}

/** 排序：按 order 升序，order 相同按 id。 */
export function sortUiExtensions<T extends { order?: number; id: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.id.localeCompare(b.id));
}
