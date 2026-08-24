/**
 * 项目组 UI 共享常量：角色 emoji 图标库 / 工具列表 / 推理级别。
 *  - emoji 库：角色/职能相关图标，供角色表单点选。
 *  - 工具列表：pi 内置基础工具（见 pi 的 createAllToolDefinitions）；
 *    团队受控工具（team_*）由 Runtime 自动注入，无需用户配置。
 */

/** 角色图标库（点选） */
export const AGENT_EMOJIS = [
  "🧭", "👤", "🤖", "🛠️", "📋", "💻", "🧪", "🔍", "📝",
  "🎨", "🛡️", "🚀", "🧩", "📊", "⚙️", "💼", "📚", "🔧",
  "🗂️", "🧾", "🕵️", "📈", "🗣️", "🧠",
];

/** 工具库（多选；pi 内置基础工具全集） */
export const AGENT_TOOLS = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
];

/** 推理级别（pi ThinkingLevel；UI 额外提供 "auto"=不设置/模型默认） */
export const THINKING_LEVELS = [
  "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
