# Pi Studio — 开发笔记

> **Pi Studio**（`@aacs111/pi-studio` v0.8.6），基于 [agegr/pi-web](https://github.com/agegr/pi-web) 二次开发：
> 原 Web UI 全部能力 + Electron 桌面壳、原生右侧浏览器控制（Semantic Browser V2）、Univer 表格深度集成、
> 上传管理、i18n（en/zh-CN）、PWA、Git 集成、项目信任、skill 安装/更新/锁定、模型目录/发现/测试、
> 视觉描述、安全加固、性能优化。
>
> **本文件只放铁律与索引；实现细节一律写进 `docs/agents/`，不要在这里堆。**

---

## AI 协作约定（必须遵守）

**修复 bug 或写完代码后，必须先自行测试验证通过再回复用户**：用 node/curl/bash 端到端验证核心逻辑路径（正常 + 边界/回退场景），打包（Electron）场景用 `ELECTRON_RUN_AS_NODE=1` 模拟子进程环境。不交付未验证的代码。

**验证范围必须匹配改动大小**（2026-09-19 实测：全量 lint 73s / tsc 21s / 单文件 eslint 11s；一个小改动因全量验证 ×5 轮把任务拖成 36 分钟）：改单个文件用 `node_modules/.bin/eslint <文件>` 代替全量 `pnpm run lint`；`tsc --noEmit` 只在**跨文件类型影响**时跑，同一轮多次微编辑不要每次重跑（收尾跑一次即可）；headless 浏览器往返只在真的动了渲染层时用。交付前若此前只做了局部验证，补一次全量（lint + tsc）收尾。#约定

**模型要「边说边做」，禁止连续多个回合只闷头调工具**：每个工具回合之间必须带一句一两行的可见正文，说明现在在做什么、下一步做什么。原因：宿主看门狗会检测「连续 N 个纯工具回合（无可见正文）」并强制注入收尾指令把任务掐断——用户看到的「还没执行好就断了、会话结束」多半就是它。只要每个回合都有可见正文，计数器就清零，任务不会被中途打断（2026-09-14 d2o 会话实测，会话 05:39 一次被触发 5 次）。这条是治本；阈值已放宽到 20（代码默认 `lib/turn-nudge.ts` 的 `TURN_NUDGE_DEFAULT_STREAK = 20`，可用 `PI_TURN_NUDGE_TOOL_ONLY` 覆盖）。**改默认值必须落在代码里**：`electron-builder.yml` 不打包 `.env*`，只改 `.env.local` 对桌面版无效（2026-09-14 踩过）。#约定

**一切 UI / 页面 / 组件 / 样式改动，一律先走 `.agents/skills/ui-design` 流水线，禁止直接改组件代码**：
阶段 0 读根 `DESIGN.md`（缺则先从该项目现有 token 抽取并落盘）→ 阶段 1 掷 `direction-seed.mjs` 外部种子后出 **6 个互斥交互范式方向**（ASCII 线框 + 视觉语言，先想内容后想界面，**只换配色不算独立方向**）→ **阶段 2 停住等用户选 1 个** → 实现 → 阶段 4 `static-check.mjs` **静态自检（不截图、不调模型：WCAG 对比度直接算 + token 违约 grep + 字号节奏）** → 阶段 5 由【独立上下文】按 `review-rubric.md` 评审源码与 DOM（禁止生成方自评）→ 一次性批量修正，**硬上限 2 轮**。
**默认不走截图 + 视觉模型评审**（实测又慢又挑模型：kimi 两次 100+ 秒并撞网关 504，相当一部分模型不支持图片输入）；仅在用户明确要求且桥与视觉模型都可用时才作为可选增强。
「Apple 风格 / 现代 / 简洁 / 高级感」这类宽约束一律视为**无效输入**（它们不携带方向信息，堆词只会回到模型最常见输出），必须换成**具体参照物 + 明确禁令 + token 数值**。机制与坑见 `docs/agents/design-system.md`。

**一切 UI / 样式结构改动，都要站在用户角度考虑美观性和使用感受**，而不是只求逻辑能跑：比例缩放的弹窗让用户自己拖动调节而不是一刀切占满全屏；按钮/间距/字号与画布尺度匹配（画布小则按钮紧凑）；功能重复/冗余的视图要删掉；点击位置、双击编辑、可 resizable 等交互细节要顺手、有获得感。改 UI 优先确认真实使用场景。

**所有弹窗（含设置弹窗、展开画布等）必须支持「顶栏拖动移动 + 四边/四角拉大缩小」**：统一用 `components/DraggableResizableModal.tsx`（createPortal 挂 body、zIndex 9999、指针事件 8 方位把手 + 顶栏拖动）。新弹窗一律用它，禁止固定尺寸 / 纯 fixed 定位 / 不可拖动不可缩放的弹窗。

---

## 核心铁律

- **开发期间永远不要跑 `next build`** — 它污染 `.next/` 并搞坏 `pnpm run dev`；打包构建走独立目录 `.next-pkg`（`PI_WEB_DIST_DIR`），互不干扰。
- **Agent 永不自动合并 worktree。** 编辑 → `worktree ready` → 停下，用户自己点「合并到主干」或明确要求。**该铁律对所有 skill 一律适用**：任何 skill 模板/流水线不得写死 `univer worktree merge`，编辑完只标记 ready 即停手。
- **用户说「编辑这张表」又没点名文件时，默认编辑 open-file 标记记录的文件**（右侧查看器里打开的那个）。用 `GET /api/open-file` 或读 `<数据目录>/.internal/pi-web-open-file.json`；缺失/未设置就问用户。
- 右侧浏览器**仅 Electron 模式可用**（`pnpm run dev:electron` 或打包应用）；`pnpm run dev` 纯浏览器模式无桥，`/api/browser/control/*` 返回 502。
- 每个改动必须过 `tsc --noEmit` + `pnpm run lint` 再交付；Univer 改动还要 headless 浏览器往返验证。
- **禁止在 Windows/Git Bash 下执行 `find /`、`find ~`、`grep -rn` 扫全盘/家目录。** 本机 C 盘遍历一次要 28 分钟以上（2026-09-03 实测把一整轮对话拖死）。要搜就限定到具体子目录（`lib`/`app`/`components`/`hooks`/`electron`），或明确目录（会话文件固定在 `~/.pi/agent/sessions/<cwdKey>/*.jsonl`）；确需可能长耗时的命令一律带 `timeout 30` / bash 工具 `timeout` 参数。#坑
- **搜查/定位用 `rg -l` 限目录 + 按需读片段**：全项目找引用一律 `rg -l "<词>" components app lib hooks electron`（限定目录，永不扫 node_modules/.next/.next-pkg/release）；命中后用 `read` 读**相关片段**而非整文件。优先 `rg -l` 一次命中，替代「多次 grep + 大段 read」的来回试探。#约定
- **排查性能问题先量化再动手**：第一步用 node / puppeteer 打时间戳，确认瓶颈在服务端还是客户端，再改代码；不许在读完代码后直接猜瓶颈下手。#约定
- **测试会话用完必须清理**：验证/调试时用脚本或 `POST /api/agent/new` 造出的会话（puppeteer 点发送键、临时 cwd、固定测试文本）**必须在同一轮任务结束前删掉**，不得留在 `~/.pi/agent/sessions/{<cwdKey>}/*.jsonl` 里污染侧栏。典型特征：cwd 在 `%TEMP%` 下、首条消息是「ABCDEF」「热身」「测试…」这类无业务含义的固定文本、体积仅 1–3KB 且消息数 ≤ 8。**删除前先移到 `~/.pi/agent/sessions-removed-<日期>/` 并写 `manifest.json`**（记原路径/id/首条消息），确认后再彻底删——直接 `rm` 弄错就没救了。2026-09-13 一次就积累出 80 个测试会话（14.7MB）。#约定 #坑

---

## Quick Start

包管理器为 pnpm（≥ 11，`package.json` 已钉版本）：依赖装删一律 `pnpm add/remove`，不要用 npm，否则会生成野的 package-lock.json。

```bash
pnpm run dev            # 浏览器模式，127.0.0.1:10141
pnpm run dev:electron   # Electron 壳 + dev server（scripts/dev-electron.mjs）
pnpm run dev:lan        # 局域网模式 0.0.0.0:30141
pnpm run pack:dir       # 只生成 release/win-unpacked（快速验证）
pnpm run pack           # 安装版 + 便携版（另有 pack:portable / pack:nsis / pack:msi）
```

Typecheck: `node_modules/.bin/tsc --noEmit`　Lint: `pnpm run lint`
打包细节（`.next-pkg`、国内镜像、`asar:false` / `npmRebuild:false`、exe 启动方式）见 `docs/agents/design-decisions.md` §Electron 桌面壳。

---

## 按需参考文档（涉及对应任务时用 read 读取）

- `docs/agents/architecture.md` — 架构：两种运行形态 + 请求链路
- `docs/agents/file-map.md` — 文件地图：app/api 路由 / lib / components / hooks / electron / 其他
- `docs/agents/design-decisions.md` — 关键设计决策与坑；**上面各条铁律的完整来龙去脉、以及下面这批约定，都在这里**
- `docs/agents/design-system.md` — 设计能力：ui-design skill 六阶段流水线、bundled skill 分发链路（`~/.agents/skills`）、`design-review.mjs` 的截图→独立视觉评审契约、迭代硬上限
- `docs/agents/formats.md` — Pi Session 文件格式 / CSS Variables / 环境变量一览

> **项目约定速览**（数据目录解析、changed-files 卡片、Fork vs 会话内分支、`enabledModels` 作用域、
> 工具全禁用、提供商列表能力驱动、模型测试路由、会话文件可整文件重写、办公文档两段式打开、打包细节）
> 全部收录在 `docs/agents/design-decisions.md` 对应小节，用到时读那一节即可。
