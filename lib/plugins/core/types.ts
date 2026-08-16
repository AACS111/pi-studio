/**
 * Pi Studio Plugin Runtime — 统一契约。
 *
 * 设计原则（来自 DSH 契约实证，docs/dsh/）：能力 = Service 适配器，不是扁平
 * registerX() 注册表。DSH / MCP / Pi 三生态的插件最终都收敛到「产物」
 * （tool / skill / command / ui），运行时差异由各自的 adapter 消化。
 * 这里只定义「插件生命周期 + 兼容性报告 + 加载产物」。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 插件来源生态。 */
export type PluginOrigin = "pi" | "dsh" | "mcp";

/** 兼容性评估（市场展示 + 升级检测用）。 */
export interface CompatReport {
  /** 0-100，由「能加载 + 能桥接 + 无未映射 seam」综合得出。 */
  score: number;
  /** 是否真跑通过（load + 桥接 + 至少一次 execute）。 */
  verified: boolean;
  /** 插件 inject 但宿主未提供的服务名。 */
  unmapped: string[];
  notes: string[];
}

/** 插件激活上下文（最小面；能力经 adapter 的 Service 注入，不经此对象）。 */
export interface PluginContext {
  cwd: string;
  logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

/** 统一插件入口。 */
export interface PiStudioPlugin {
  /** 稳定 id，跨生态加前缀：`dsh:` / `pi:` / `mcp:`。 */
  id: string;
  name: string;
  version: string;
  origin: PluginOrigin;
  compat: CompatReport;
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

/**
 * 一个 DSH 插件加载并桥接后的产物 —— 这是 DSH adapter 的核心输出，
 * 交给 Pi 的 session / skill registry / 市场消费。
 */
export interface DshPluginArtifacts {
  packageName: string;
  version: string;
  /** 桥接后的 pi ToolDefinition（可直接作为 session 的 customTools）。 */
  tools: ToolDefinition[];
  /** 识别的 skill 目录（内含 SKILL.md），交给 skill adapter 转 pi skill。 */
  skillPaths: string[];
  /** 插件 inject 但宿主未提供、导致对应功能缺失的服务名。 */
  unmappedServices: string[];
}

/** 已注册进 runtime 的插件记录（plugin-registry.ts 的条目）。 */
export interface RegisteredPlugin {
  id: string;
  origin: PluginOrigin;
  name: string;
  version: string;
  compat: CompatReport;
  /** DSH 生态的桥接产物（其他生态可扩展对应字段）。 */
  artifacts?: DshPluginArtifacts;
  loadedAt: number;
}
