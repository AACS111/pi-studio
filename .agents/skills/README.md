# 项目内 Skills（随项目打包部署）

本目录是 pi 的**项目级 skills**，随仓库一起部署。新服务器上克隆/解压本仓库后，pi 在这个项目里运行时自动发现并加载（`.agents/skills/` 目录约定，cwd 及祖先目录递归发现）。

## 包含的 skill

| 目录 | 用途 |
|---|---|
| `web-preview/` | 在 pi-studio 右侧面板打开网页浏览器（Codex 式预览）——agent 通过 `POST /api/browser` 把网页（如刚启动的 dev server）推送到右侧面板 |
| `browser-control/` | 控制真实浏览器（browser-use 侧车 127.0.0.1:17865，驱动系统 Chrome headless）——点击/输入/滚动/前进后退/刷新/截图/提取页面 Markdown/LLM 驱动 Agent，用于交互和内容诊断 |
| `sheet-edit/` | 编辑 pi-studio 右侧打开的表格（.univer/.xlsx）——读单元格、改值、格式、插入行、工作区生命周期、写回、导出。含 2026-08-07 交付流程铁律（先验证后交付、不自动合并、工作区复用等）及 2026-08-08 工作区只读编辑规则、`univer-ops.mjs` 通用操作库、SQLite changesets 快速验证脚本 |
| `univer-cli/` | Univer CLI 基础操作参考（sheet-edit 的底层依赖，`hidden: true` 辅助 skill） |
| `univer-integrate/` | 官方 univer-sdk-skills 的集成 + Facade 操作参考（2026-08-08 从 `npx skills add dream-num/univer-sdk-skills` 手工修复 YAML 后纳入；另三个官方 skill univer-node-backend/plugin-dev/pro-integrate 在用户级 `~/.agents/skills/`） |

## 部署到新服务器的前置条件

1. **`univer` CLI 已安装**（`npm i -g univer-cli` 或项目依赖）。所有表格操作、`/api/univer/*` 路由都靠它；它自带参考文档：`univer skills get core` / `univer skills get sheet`。
2. **pi-studio 已运行**（dev 或打包后）。skill 读取 pi-studio 数据目录下的打开文件标记（默认 `<项目>/pi-web-uploads/.internal/pi-web-open-file.json`，推荐 `GET /api/open-file`）确定右侧打开的文件——该文件由 pi-studio 的 `/api/open-file` 自动写入，无需手工配置。
3. **信任项目**：pi 只在项目被信任后才加载项目级 `.agents/skills`。首次在这个项目里打开 pi 会提示信任，批准即可；或在全局设置 `defaultProjectTrust: "always"`；也可调 `POST /api/project-trust`（body `{cwd}`）通过 pi-studio 信任。信任记录写入 `~/.pi/agent/trust.json`（与 pi CLI 共享）。

## 注意事项

- `.agents/` 不要加进 `.gitignore`（否则打包后丢失）。
- 本机若同时存在全局同名 skill（`~/.pi/agent/skills/`），加载器按作用域优先级取项目版；新服务器没有全局版，不受影响。
- 修改本目录 skill 后无需重启——pi 启动时扫描，pi-studio 的 `/api/skills` 实时列出。
