# Pi Studio — 开发笔记

> 本项目是 **Pi Studio**（`@aacs111/pi-studio` v0.8.6），基于 [agegr/pi-web](https://github.com/agegr/pi-web)
> 二次开发：保留原 Web UI 的全部能力，新增 **Electron 桌面壳**、**原生右侧浏览器控制（Semantic Browser V2）**、
> **Univer 表格深度集成**、**上传管理器**、**i18n（en/zh-CN）**、**PWA**、**Git 集成**、**项目信任**、
> **skill 安装/更新/锁定**、**模型目录/发现/测试**、**视觉描述**、**安全加固**、**性能优化**等。

---

## AI 协作约定（必须遵守）

**修复 bug 或写完代码后，必须先自行测试验证通过再回复用户。** 不交付未经验证的代码。
测试方式：用 node/curl/bash 端到端验证核心逻辑路径（正常场景 + 边界/回退场景），确认功能可用、
输出符合预期。涉及打包（Electron）场景时用环境变量（如 `ELECTRON_RUN_AS_NODE=1`）模拟子进程环境。

**一切 UI / 样式结构改动，都必须站在用户角度考虑美观性和使用感受**，而不是只求逻辑能跑：
缩放弹窗不能一刀切占满全屏而是让用户自己拖动调节大小；按钮/间距/字号要与画布尺度匹配（
画布小则左侧按钮要紧凑）；功能重复/冗余的视图（如已有流程图视图下的边列表）要去掉；
交互细节（如点击位置、双击编辑、可 resizable）要让用户顺手、有获得感。改 UI 优先确认真实使用场景。

**所有弹窗（含设置弹窗、展开画布等）必须支持「顶栏拖动移动 + 四边/四角拉大缩小」**：统一用
`components/DraggableResizableModal.tsx`（createPortal 挂 body、zIndex 9999、指针事件 8 方位把手 + 顶栏拖动）。
新弹窗一律用它，禁止再用固定尺寸 / 纯 fixed 定位、不可拖动不可缩放的弹窗。

---

## 核心铁律

- **开发期间永远不要跑 `next build`** — 它污染 `.next/` 并搞坏 `npm run dev`。打包构建走独立目录 `.next-pkg`（`PI_WEB_DIST_DIR`），互不干扰。
- **Agent 永不自动合并 worktree。** 在 worktree 上编辑 → `worktree ready` → 停下，用户自己在查看器里点「合并到主干」或明确要求。**该铁律对所有 skill 一律适用，不限于 sheet-edit**：任何 skill 模板/流水线**不得写死 `univer worktree merge`**（office-edit 第 3 步已改为 `worktree ready`），编辑完只标记 ready 即停手。
- **用户说「编辑这张表」又没点名文件时，默认编辑 open-file 标记记录的文件**（右侧查看器里打开的那个）。用 `GET /api/open-file` 或读 `<数据目录>/.internal/pi-web-open-file.json`；缺失/未设置就问用户。
- 右侧浏览器**仅 Electron 模式可用**（`npm run dev:electron` 或打包应用）；`npm run dev` 纯浏览器模式无桥，`/api/browser/control/*` 返回 502。
- 每个改动必须过 `tsc --noEmit` + `npm run lint` 再交付；Univer 改动还要 headless 浏览器往返验证。

---

## Quick Start

```bash
npm run dev            # 浏览器模式，127.0.0.1:10141（见 package.json 的 dev script）
npm run dev:electron   # Electron 壳 + dev server（scripts/dev-electron.mjs）
npm run dev:lan        # 局域网模式 0.0.0.0:30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`
Lint: `npm run lint`

### 打包桌面应用

```bash
npm run pack:dir       # 只生成 release/win-unpacked（快速验证）
npm run pack:portable  # 单文件便携版 .exe
npm run pack:nsis      # 安装版 .exe
npm run pack:msi       # .msi
npm run pack           # 安装版 + 便携版
```

- `scripts/package.mjs` 自动设置 `PI_WEB_DIST_DIR=.next-pkg` 和国内镜像（electron-builder-binaries / electron），GitHub 不可达时不会卡下载。
- `electron-builder.yml`：`asar: false`（内置服务要读真实文件路径）、`npmRebuild: false`（原生依赖均为预编译产物）。
- 打出来的 exe 用 `electron/main.cjs` 以「本 exe + `ELECTRON_RUN_AS_NODE=1`」方式启动内置 Next 服务（随机空闲端口，只监听 127.0.0.1）。

---

## 按需参考文档（涉及对应任务时用 read 读取）

- `docs/agents/architecture.md` — 架构：两种运行形态 + 请求链路
- `docs/agents/file-map.md` — 文件地图：app/api 路由 / lib / components / hooks / electron / 其他
- `docs/agents/design-decisions.md` — 关键设计决策与坑（open-file 标记、changed-files 卡片、AgentSession 生命周期、Fork、worktree、Univer 就地同步、KET 桥、Electron 壳、浏览器桥、安全模型、性能、Temp 卫生）
- `docs/agents/formats.md` — Pi Session 文件格式 / CSS Variables / 环境变量一览

---

## 关键约定速览（详细见 docs/agents/）

- **数据目录**：上传、AI 编辑产物、内部状态都在可配置数据目录（默认 `<项目>/pi-web-uploads/`，`.internal/` 存内部状态）。解析顺序：`PI_WEB_UPLOADS_DIR` env → `.pi-web-config.json` 的 `uploadsDir` → 项目默认。
- **changed-files 卡片**：`extractChangedFiles()`（`lib/changed-files.ts`）扫工具块里的 `edit`/`write`（input 字段是 `path` 不是 `filePath`）；非项目文件不显示；生成文件（表格/文档/图片）要 `POST /api/open-file-request` 自动推右侧。
- **Fork vs 会话内分支**：Fork 创建独立新 `.jsonl`（parentSession 头字段挂子节点）；会话内分支走 `navigate_tree`（同一文件共享 parentId）。
- **enabledModels 作用域**：用 pi `--models` 语法（minimatch glob），委托 `lib/model-scope.ts` 的 `resolveModelScopeWithDiagnostics()` 解析，**永远别当字面字符串比较**。
- **工具全禁用时**（`toolNames = []`）：`rpc-manager.ts` 传空 allow-list 并强制 `agent.state.systemPrompt = ""`（启动/重载/资源发现之后都要设）。
- **提供商列表能力驱动，绝不 id 驱动**（`lib/provider-listing.ts`）；双认证提供商（anthropic、github-copilot）恰好出现一次、绝不双列。
- **模型测试路由**是 `app/api/models-config/test/route.ts`；`app/api/models/test/` 不是真实路由。
- **会话文件可整文件重写**：`parentSession` 头字段只是显示元数据，删除会话时用它级联重挂子会话。
- **办公文档两段式打开**（.doc/.docx/.ppt/.pptx，与表格体验一致）：默认直接原生预览 —— doc/docx 走 mammoth HTML 预览（DocumentViewer），ppt/pptx 走隐藏缓存只读预览（`POST /api/univer/ppt-preview` 转换副本落在 `.internal/univer-view-cache/` 不进任何文件列表 + 网关 iframe）；只有点「AI 编辑」才经 `POST /api/univer/from-xlsx` 生成可见的 `<basename>-ai-edit.univer` 进 worktree 工作流。agent 对话里被要求「创建/编辑 PPT、文档」时一律用 office-edit skill 操作 .univer 文件并 `open-file-request` 推右侧，需要交付原件再 export 回 .docx/.pptx。#坑 UniferFileViewer 对纯 doc/slide 单元绝不能走 `/api/univer/view` 的 xlsx 导出（CLI 报 cannot export doc unit as xlsx），已按 units 含 sheet 与否门控。
