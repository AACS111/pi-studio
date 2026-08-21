// DSH 生态目录（远端商店 dsh.deepseek404.com）共享定义。
// 注意：Next.js App Router route 文件只允许导出路由句柄与 config，
// 任何常量/类型都必须放这里，route 里 import，否则打包时 checkFields 类型校验失败。
// 与 lib/dsh-catalog.ts（内置目录数据）区分：这里只管远端商店抓取相关。

export interface DshStoreItem {
  name: string; // repo name
  author: string; // owner
  description: string;
  category: string; // 分类（mono-label）
  type: string; // 类型（完整应用/工具/技能…）
  topics: string[];
  stars: number;
  forks: number;
  issues: number;
  updatedLabel: string;
  repo: string; // "owner/repo"
  githubUrl: string;
  detailUrl: string;
}

export const DSH_STORE_CATEGORIES = [
  "agent-session",
  "communication",
  "data",
  "development",
  "lifestyle",
  "model-mcp",
  "operations",
  "other",
  "research",
  "security",
  "ui",
] as const;

/** 分类 slug → 中文名（站点固定分类，抓自首页 category-row）。 */
export const DSH_STORE_CATEGORY_LABELS: Record<string, string> = {
  "agent-session": "Agent 与会话",
  communication: "消息通讯",
  data: "文件与数据",
  development: "开发工具",
  lifestyle: "生活娱乐",
  "model-mcp": "模型与 MCP",
  operations: "部署运维",
  other: "其他",
  research: "学习研究",
  security: "安全与治理",
  ui: "界面增强",
};
