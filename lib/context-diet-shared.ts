/**
 * ContextDietSettings 的共享部分：类型 + 默认值 + 面板档位选项。
 *
 * **这里不能 import 任何 node: 模块或 @earendil-works/* 服务端包** ——
 * components/SettingsPanel.tsx（客户端组件）会直接引用本文件，
 * 一旦间接拉进 pi-coding-agent 就会让浏览器 bundle 解析 child_process 失败。
 * 读写逻辑在 lib/context-diet-settings.ts（服务端专用）。
 */

export interface ContextDietSettings {
  enabled: boolean;
  /** 保留最近 N 条工具结果原文（更旧的才折叠） */
  keepRecentToolResults: number;
  /** 工具结果文本长度达到该值才折叠（字符数） */
  foldMinChars: number;
  /** 保留最近 N 张历史工具截图（其余换成占位符） */
  keepRecentImages: number;
}

export type ContextDietSettingsPatch = Partial<ContextDietSettings>;

export const CONTEXT_DIET_DEFAULTS: ContextDietSettings = {
  enabled: true,
  keepRecentToolResults: 8,
  foldMinChars: 2000,
  keepRecentImages: 3,
};

/** 设置面板里每个参数的滑块范围（值域与后端 clamp 保持一致） */
export const CONTEXT_DIET_RANGES = {
  keepRecentToolResults: { min: 0, max: 32, step: 1 },
  foldMinChars: { min: 200, max: 8000, step: 100 },
  keepRecentImages: { min: 0, max: 10, step: 1 },
} as const;
