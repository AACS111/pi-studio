// Curated DeepSeek Harness (dsh) plugin catalog for pi-studio.
//
// dsh plugins mount on the dsh runtime's `ctx.*` seams. Compatibility with
// pi-studio falls into three categories (see the marketplace panel):
//
//   A — pi has an equivalent capability → recommend the pi plugin instead.
//   B — client-UI / web plugin → installable via the dsh sidecar adapter.
//   C — host/runtime seam plugin → incompatible with pi-studio (grayed out).
//
// This list is curated by hand (dsh has no stable registry API; npm search
// `keywords:dsh-plugin` is noisy and version-churny). Add new entries here.

export type DshCategory = "A" | "B" | "C";

export interface DshPiRecommend {
  /** Which pi market to jump to. */
  target: "plugins" | "skills";
  /** Pre-filled search query in that market. */
  query: string;
  /** Human-readable label of the recommended pi equivalent. */
  label: string;
}

export interface DshCatalogItem {
  /** npm package name (used for B installs). */
  package: string;
  /** Display name. */
  name: string;
  description: string;
  category: DshCategory;
  /** Short reason shown in the UI (why this category). */
  reason: string;
  /** A类 only: the recommended pi equivalent + jump query. */
  piRecommend?: DshPiRecommend;
  /** B类 only: this package is already bundled into another aggregate package.
   *  Installing both causes a duplicate loader entry crash. */
  includedIn?: string;
}

export const DSH_CATALOG: DshCatalogItem[] = [
  // ── A 类：pi 有等价能力，推荐直接装 pi 插件 ──────────────────────────
  {
    package: "@memtensor/memos-local-plugin",
    name: "memos 记忆",
    description: "分层 L1/L2/L3 记忆 + 反思加权（dsh 记忆插件）",
    category: "A",
    reason: "pi 已有等价记忆插件，无需适配器",
    piRecommend: { target: "skills", query: "memory", label: "pi-memory / pi-memory-zh" },
  },
  {
    package: "@liustack/modsearch",
    name: "联网搜索",
    description: "插件式 web/X 搜索与页面抓取",
    category: "A",
    reason: "pi 有 web search 工具与 MCP 等价物",
    piRecommend: { target: "skills", query: "web search", label: "pi web-search / MCP" },
  },
  {
    package: "@liustack/pptfast",
    name: "PPT 生成",
    description: "语义 IR 驱动的 PPTX 生成",
    category: "A",
    reason: "pi 有 univer/report 技能等价物",
    piRecommend: { target: "skills", query: "report ppt", label: "univer-report-gen" },
  },
  {
    package: "@deepseek-ai/dsh-mcp",
    name: "MCP 客户端",
    description: "Model Context Protocol 客户端 seam",
    category: "A",
    reason: "pi 有 MCP 适配能力",
    piRecommend: { target: "plugins", query: "mcp", label: "pi-mcp-adapter" },
  },
  {
    package: "@deepseek-ai/dsh-skill",
    name: "技能提供器",
    description: "Agent skill 注册表 seam",
    category: "A",
    reason: "pi 的 skills.sh 生态等价",
    piRecommend: { target: "skills", query: "skill", label: "skills.sh 技能市场" },
  },
  {
    package: "@deepseek-ai/dsh-lsp",
    name: "LSP 集成",
    description: "语言服务器协议接入 seam",
    category: "A",
    reason: "pi 有 lsp 工具",
    piRecommend: { target: "skills", query: "lsp", label: "pi lsp 工具" },
  },
  {
    package: "@deepseek-ai/dsh-plan-mode",
    name: "规划模式",
    description: "任务规划工作流 seam",
    category: "A",
    reason: "pi 用 system prompt + 思考级别等价实现",
    piRecommend: { target: "plugins", query: "plan", label: "pi plan 模式预设" },
  },
  {
    package: "@deepseek-ai/dsh-persona",
    name: "人设部署",
    description: "Composition 人设段落 seam",
    category: "A",
    reason: "pi 用 system prompt 直接配置",
    piRecommend: { target: "plugins", query: "prompt", label: "pi prompt 模板" },
  },

  // ── B 类：客户端 UI 插件，经 sidecar 适配器直接安装 ──────────────────
  {
    package: "@linxin666/dsh-web-ui-all",
    name: "dsh-web-ui 全家桶",
    description: "任务看板 / Git 图谱 / 右侧面板 / 皮肤中心 / 移动端远程",
    category: "B",
    reason: "挂载到 dsh Web UI，经适配器嵌入右面板即可用",
  },
  {
    package: "@linxin666/dsh-client-ui-task-board",
    name: "任务看板",
    description: "多列看板 + cron 定时真实执行",
    category: "B",
    reason: "dsh Web UI 面板插件",
    includedIn: "@linxin666/dsh-web-ui-all",
  },
  {
    package: "@linxin666/dsh-skins",
    name: "皮肤中心",
    description: "10 款皮肤一键试穿",
    category: "B",
    reason: "dsh Web UI 皮肤插件",
    includedIn: "@linxin666/dsh-web-ui-all",
  },
  {
    package: "@linxin666/dsh-ssh",
    name: "SSH 运维",
    description: "远程连接（SSH）面板",
    category: "B",
    reason: "dsh Web UI 面板插件",
    includedIn: "@linxin666/dsh-web-ui-all",
  },
  {
    package: "@linxin666/dsh-tool-describe-image",
    name: "图像理解",
    description: "图像描述工具",
    category: "B",
    reason: "dsh 工具 + UI 插件",
    includedIn: "@linxin666/dsh-web-ui-all",
  },
  {
    package: "@linxin666/dsh-pet",
    name: "鲸鱼娘宠物",
    description: "常驻桌宠，跟智能体状态换动画",
    category: "B",
    reason: "dsh Web UI 装饰插件",
    includedIn: "@linxin666/dsh-web-ui-all",
  },
  {
    package: "@linxin666/dsh-liangshen",
    name: "梁神模式",
    description: "面向 V4 Pro 的两阶段锚定预设",
    category: "B",
    reason: "属 web-ui 家族；其能力也可用 pi 预设复刻（见 A 类思路）",
    includedIn: "@linxin666/dsh-web-ui-all",
  },
  {
    package: "dshmarket",
    name: "dsh 插件市场",
    description: "dsh 内置的可视化插件市场",
    category: "B",
    reason: "dsh Web UI 插件",
  },
  {
    package: "dsh-pocket",
    name: "口袋远程",
    description: "手机扫码同步访问 DSH",
    category: "B",
    reason: "dsh Web UI + 网络插件",
  },
  {
    package: "dsh-web-open",
    name: "自动开浏览器",
    description: "托盘图标 + 桌面快捷键",
    category: "B",
    reason: "dsh 宿主辅助插件",
  },

  // ── C 类：宿主运行时 seam，完全不兼容 ────────────────────────────────
  {
    package: "@deepseek-ai/dsh-fs",
    name: "文件系统 seam",
    description: "ctx.fs 能力 seam",
    category: "C",
    reason: "pi 文件访问内建，不可替换",
  },
  {
    package: "@deepseek-ai/dsh-subprocess-local",
    name: "子进程 seam",
    description: "ctx.subprocess 本地实现",
    category: "C",
    reason: "pi bash 工具内建",
  },
  {
    package: "@deepseek-ai/dsh-sandbox",
    name: "沙箱 seam",
    description: "ctx.sandbox 能力 seam",
    category: "C",
    reason: "pi 无沙箱 seam，安全模型不同",
  },
  {
    package: "@deepseek-ai/dsh-session-persistence",
    name: "会话持久化 seam",
    description: "ctx.sessionPersistence 能力 seam",
    category: "C",
    reason: "pi 用 .jsonl 文件 + SessionManager",
  },
  {
    package: "@deepseek-ai/dsh-storage",
    name: "存储 hub",
    description: "ctx.storage 非会话存储",
    category: "C",
    reason: "pi 用数据目录 + settings 文件",
  },
  {
    package: "@deepseek-ai/dsh-credentials",
    name: "凭据 seam",
    description: "ctx.credentials 能力 seam",
    category: "C",
    reason: "pi 用 auth.json + models.json",
  },
  {
    package: "@deepseek-ai/dsh-agent-loop",
    name: "Agent 循环 seam",
    description: "ctx.agentLoop 能力 seam",
    category: "C",
    reason: "pi agent loop 内建",
  },
  {
    package: "@deepseek-ai/dsh-compaction",
    name: "压缩 seam",
    description: "ctx.compaction 能力 seam",
    category: "C",
    reason: "pi compaction 内建",
  },
  {
    package: "@deepseek-ai/dsh-llm",
    name: "LLM 适配器注册表",
    description: "ctx.llm 能力 seam",
    category: "C",
    reason: "pi 用 models.json + Provider 注册",
  },
  {
    package: "@deepseek-ai/dsh-token-meter",
    name: "Token 计量",
    description: "重放 token 测量 seam",
    category: "C",
    reason: "pi token 计量内建",
  },
  {
    package: "@deepseek-ai/dsh-attachment-local",
    name: "附件存储",
    description: "ctx.attachments 本地实现",
    category: "C",
    reason: "pi 附件/上传机制内建",
  },
];

export function getDshCatalog(): DshCatalogItem[] {
  return DSH_CATALOG;
}

/** Official source repo for a dsh package, when known. */
export function dshRepoOf(pkg: string): string | null {
  if (pkg.startsWith("@deepseek-ai/dsh")) {
    return "https://github.com/deepseek-ai/deepseek-harness";
  }
  if (pkg.startsWith("@linxin666/")) {
    return "https://github.com/zhu1090093659/dsh-web-ui";
  }
  return null;
}

/** npm package page for a dsh package (always available). */
export function dshNpmUrlOf(pkg: string): string {
  return `https://www.npmjs.com/package/${pkg}`;
}
