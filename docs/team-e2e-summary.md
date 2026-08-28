# Pi Studio 目录结构总览

> 本文档基于 2026-08-27 实际目录扫描生成并核验，供团队 E2E 流程验证与新人上手参考。
> 核验范围：顶层目录、app/、app/api/、lib/、lib/team/、components/、hooks/、electron/、scripts/、docs/agents/ 均与实际一致。

Pi Studio（`@aacs111/pi-studio` v0.8.6）是基于 [agegr/pi-web](https://github.com/agegr/pi-web) 二次开发的 AI 编码助手 IDE，包含 Next.js Web 端 + Electron 桌面壳 + Univer 表格深度集成 + 项目组（Team）多角色协作等能力。

---

## 顶层目录

| 目录/文件 | 作用 |
| --- | --- |
| `app/` | Next.js App Router：页面、API 路由、全局样式、PWA manifest |
| `components/` | React 组件库（AppShell、ChatWindow、FileExplorer、UniverFileViewer、TeamChat、SettingsPanel 等） |
| `hooks/` | 自定义 React Hooks（useAgentSession、useTeamRun、useI18n、useTheme、useResizablePanel…） |
| `lib/` | 核心逻辑库（rpc-manager、provider-listing、model-scope、univer-*、team/、changed-files…），含大量 `*.test.mjs` |
| `electron/` | Electron 桌面壳：`main.cjs`（主进程）、`preload.cjs`（预加载）、`bridge.cjs`（浏览器控制桥） |
| `scripts/` | 构建/开发脚本：`dev-electron.mjs`、`package.mjs`、`run-dev.mjs`、`gen-icons.mjs` |
| `tools/` | 工具脚本预留目录（当前为空） |
| `packages/` | 子包：`pi-memory-zh/`（中文记忆模块） |
| `docs/` | 文档：`agents/`（架构/文件地图/设计决策）、`dsh/`、`team/`、`team-analysis/`、`team-tasks/`、`release.md`、`i18n.md`、`worktrees.md` |
| `public/` | 静态资源 |
| `build/` | 构建中间产物 |
| `release/` | electron-builder 打包输出 |
| `.next/` | Next.js dev/build 缓存（开发期用，禁止手动删） |
| `.next-pkg/` | 打包专用 dist 目录（`PI_WEB_DIST_DIR`，与 `.next/` 隔离） |
| `.agents/` | 本项目自带的 agent skills（browser-control、sheet-edit、univer-cli、web-preview） |
| `pi-web-uploads/` | 数据目录：上传文件、AI 编辑产物、`.internal/` 内部状态（open-file 标记等） |

顶层其他次要文件：`package.json` / `tsconfig.json` / `next.config.mjs` / `tailwind.config.ts` / `postcss.config.mjs` / `eslint.config.mjs` / `electron-builder.yml` / `proxy.ts`（Next 自定义代理）/ `instrumentation.ts`（OpenTelemetry 钩子）/ `restart-dev.ps1`（重启 dev 脚本）/ `.pi-web-config.json`（数据目录等本地配置）/ `settings.bak.json`（设置备份）/ `pnpm-workspace.yaml` + `bun.lock` + `package-lock.json`（包管理）。

---

## 关键子目录速览

### `app/`
- `api/` — 后端 API 路由（共 26 个子目录，见下表）
- `page.tsx` / `layout.tsx` — 入口页面与全局布局
- `file/` — 文件查看路由（动态 `[...]` catch-all）
- `globals.css` — 全局样式（含 CSS Variables 主题）
- `manifest.ts` — PWA manifest

#### `app/api/` 路由清单（已核对实际目录，共 26 个）
agent、auth、browser、cwd、default-cwd、dsh、file-index、files、git、home、models、models-config、open-file、open-file-request、packages、plugins、project-trust、sessions、skills、teams、terminal、univer、update、uploads、vision、worktrees。

### `lib/team/`（项目组多角色协作核心，已核对实际文件）
- `runtime.ts` — RunManager 执行循环（cancel 强制收敛兜底、循环守卫）
- `executor.ts` — 角色执行器（maxTurns 控制、群聊消息兜底、变更文件透传）
- `engine.ts` — 状态机引擎（Transition / Gateway）
- `store.ts` — 事件存储 + projection（含快照/边界修复）
- `registry.ts` — 角色注册表
- `library.ts` — 角色库（leader/dev/tester 等工具编排）
- `templates.ts` — 角色/工作流模板
- `context.ts` — 角色上下文块
- `validate.ts` — 工作流校验（custom vs 内置预设分档）
- `tools.ts` — team_handoff / team_create_task / team_complete_task / team_record_decision 工具
- `types.ts` / `ui-constants.ts` — 类型与 UI 常量
- `lifecycle.ts` / `task-classify.ts` / `node-loader.mjs` — 生命周期、任务分类、TS loader
- 测试：`*.test.mjs`（engine/gateway/exec-mode/parallel/run-lifecycle/solver/store/visibility/tools/snapshot-boundary 等 14+ 个）

### `lib/` 关键模块（已核对实际文件）
- `rpc-manager.ts` — 与 pi core 的 RPC 会话管理（denyToolNames、cwdOverride、扩展工具过滤）
- `allowed-roots.ts` — 工具根路径解析
- `provider-listing.ts` / `provider-listing-runtime.ts` — 提供商列表（能力驱动，不 id 驱动）
- `model-scope.ts` / `model-catalog.ts` / `model-discovery.ts` / `models-cache.ts` — 模型作用域、目录、发现、缓存
- `changed-files.ts` — 提取工具块里的 edit/write 变更文件卡片
- `univer-cli.ts` / `univer-compact.ts` / `univer-db.ts` / `univer-dims.ts` / `univer-paths.ts` / `univer-unit-id.ts` / `univer-user-edits.ts` / `univer-view-cache.ts` — Univer 表格集成全套
- `git-changes.ts` / `git-exec.ts` / `git-status.ts` / `git-types.ts` / `worktree.ts` — Git 集成与 worktree 管理
- `project-trust.ts` / `path-security.ts` / `request-security.ts` / `file-access.ts` — 安全加固
- `ket-bridge.ts` — KET 桥（Univer 加密表）
- `terminal-manager.ts` / `terminal-session.ts` / `terminal-input.ts` / `bash-output.ts` — 终端集成
- 其余：`*.test.mjs` 系列覆盖各模块单测；`i18n/`（国际化资源）、`plugins/`（插件）、`agent-client.ts`、`api-types.ts`、`atomic-file.ts`、`clipboard.ts`、`compaction-*.ts`、`dsh-catalog.ts`、`directory-browser.ts`、`file-dirent.ts`、`file-fuzzy.ts`、`file-types.ts`、`file-upload.ts`、`image-attachments.ts`、`markdown.ts`、`message-display.ts`、`npx.ts`、`normalize.ts`、`pi-types.ts`、`session-*.ts`、`skill-*.ts`、`skills-service.ts`、`startup-preferences.ts`、`storage-config.ts`、`tool-presets.ts`、`update-manager.ts`、`uploads.ts`、`vision-model.ts`、`web-auth.ts`

### `components/` 关键组件（已核对实际文件）
- `AppShell.tsx` / `ActivityBar.tsx` / `TabBar.tsx` / `WindowControls.tsx` — 主框架
- `ChatWindow.tsx` / `ChatInput.tsx` / `MessageView.tsx` / `MarkdownBody.tsx` / `ChatMinimap.tsx` — 对话
- `TeamChat.tsx` / `TeamCreateDialog.tsx` / `TeamSettings.tsx` / `WorkflowEditor.tsx` — 项目组
- `UniverFileViewer.tsx` / `XlsxViewer.tsx` / `univer-worker.ts` — 表格查看
- `FileExplorer.tsx` / `FileViewer.tsx` / `WebViewer.tsx` / `DirectoryPicker.tsx` — 侧边/右侧面板
- `DraggableResizableModal.tsx` — 统一弹窗基座（顶栏拖动 + 8 方位缩放）
- `SettingsPanel.tsx` / `ModelsConfig.tsx` / `ModelSelect.tsx` / `SkillsConfig.tsx` / `SkillsPanel.tsx` / `PluginsConfig.tsx` — 配置面板
- `UploadsManager.tsx` / `ChangedFilesCard.tsx`（已合并生成文件卡）— 产物与变更展示
- `CommandPalette.tsx` / `GlowBackground.tsx` / `ExpandCanvasOverlay.tsx` / `PwaRegistration.tsx` — 辅助
- `DshMarketPanel.tsx` / `DshClientLoader.tsx` / `PluginHost.tsx` / `AgentLibraryPanel.tsx` / `AgentFieldPickers.tsx` — 扩展市场与插件宿主
- `BranchNavigator.tsx` / `ProjectTrustDialog.tsx` / `FileIcons.tsx` / `ExtensionStatusBar.tsx` — 导航与状态

### `hooks/`（已核对实际文件）
`useAgentSession.ts`、`useTeamRun.ts`、`useI18n.tsx`、`useTheme.ts`、`useResizablePanel.ts`、`useAccentColor.ts`、`useAudio.ts`、`useDragDrop.ts`、`useGlowBackground.ts`、`useIsMobile.ts`、`useKeyboardShortcuts.ts`、`useViewportHeight.ts`（含 `*.test.mjs`）

### `electron/`（已核对实际文件）
- `main.cjs` — 主进程，以 `ELECTRON_RUN_AS_NODE=1` 启动内置 Next 服务，随机端口仅监听 127.0.0.1
- `preload.cjs` — 渲染进程预加载，暴露桥 API
- `bridge.cjs` — 右侧 Semantic Browser V2（原生 WebContentsView）控制桥

### `scripts/`（已核对实际文件）
- `dev-electron.mjs` — Electron 壳 + dev server 启动
- `package.mjs` — electron-builder 打包（自动设 `PI_WEB_DIST_DIR=.next-pkg` + 国内镜像）
- `run-dev.mjs` — 浏览器模式 dev server 启动
- `gen-icons.mjs` — 图标生成

### `docs/agents/`（AI 协作必读，已核对实际文件）
- `architecture.md` — 两种运行形态 + 请求链路
- `file-map.md` — 文件地图（API 路由 / lib / components / hooks 索引）
- `design-decisions.md` — 关键设计决策与坑（open-file 标记、changed-files、Fork、worktree、Univer 就地同步、浏览器桥、安全模型、性能）
- `formats.md` — Session 文件格式 / CSS Variables / 环境变量一览
- `team-runtime.md` — 项目组运行时（角色 RPC 会话、executor 循环、上下文块）
- `team-create-input-solution.md` — 项目组创建/输入场景的解决方案说明

### `docs/` 其他
- `dsh/` — DSH 扩展相关文档
- `team/`、`team-analysis/`、`team-tasks/` — 项目组会话记录、分析、任务清单
- `release.md` / `i18n.md` / `worktrees.md` / `worktrees.zh-CN.md` — 发布说明、国际化、worktree 使用

---

## 运行方式

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 浏览器模式，127.0.0.1:10141（无右侧浏览器桥，`/api/browser/control/*` 返回 502） |
| `npm run dev:electron` | Electron 壳 + dev server（右侧浏览器可用） |
| `npm run dev:lan` | 局域网模式 0.0.0.0:30141 |
| `npm run pack:nsis` | 安装版 .exe |
| `npm run pack:portable` | 单文件便携版 |
| `npm run pack:msi` | .msi 安装包 |
| `node_modules/.bin/tsc --noEmit` | 类型检查 |
| `npm run lint` | ESLint |

---

## 数据目录约定

- 解析顺序：`PI_WEB_UPLOADS_DIR` env → `.pi-web-config.json` 的 `uploadsDir` → 项目默认 `pi-web-uploads/`
- `.internal/` 存内部状态：`pi-web-open-file.json`（右侧打开文件标记）等
- 打包时 `asar: false`（内置服务需读真实文件路径）、`npmRebuild: false`（原生依赖为预编译产物）

---

## 核心铁律摘要

1. 开发期间**永不跑 `next build`**（污染 `.next/` 影响 `npm run dev`），打包走独立 `.next-pkg/`。
2. Agent **永不自动合并 worktree**，需用户在查看器点「合并到主干」或明确要求。
3. 用户说「编辑这张表」未点名文件时，默认读 open-file 标记。
4. 右侧浏览器**仅 Electron 模式可用**。
5. 每个改动必须过 `tsc --noEmit` + `npm run lint`，Univer 改动还要 headless 往返验证。
6. 所有弹窗统一用 `components/DraggableResizableModal.tsx`（可拖动+可缩放）。
