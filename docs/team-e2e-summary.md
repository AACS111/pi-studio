# Pi Studio 项目目录结构说明

> 生成时间：2026-08-23 · 本轮核验：2026-08-26（writer 角色据当前目录实测重扫并更新计数）
> 来源：Team E2E 流程（组长 → 文档 → 组长收尾）
> 说明：本文档根据当前项目目录实际扫描结果编写，供团队协作与后续角色参考。
> 统计口径：文件数 = `find <目录> -type f`（排除 node_modules），下表为写本文档前实测值。

## 一、项目概览

本项目为 **Pi Studio**（`@aacs111/pi-studio` v0.8.6），基于 [agegr/pi-web](https://github.com/agegr/pi-web) 二次开发。
技术栈：Next.js（App Router）+ React + TypeScript + Tailwind，附带 Electron 桌面壳与多套集成能力
（Semantic Browser V2、Univer 表格、i18n、PWA、Git 集成、DSH 插件生态、多 Agent 项目组 Runtime 等）。

## 二、顶层目录结构

```
pi-web-main/
├── app/               # Next.js App Router（页面 + 全部 /api 路由）
│   ├── api/           # 后端 API 路由（agent/auth/browser/dsh/sessions/teams/univer 等）
│   ├── file/          # 文件相关页面
│   ├── globals.css    # 全局样式
│   ├── layout.tsx     # 根布局
│   ├── manifest.ts    # PWA manifest
│   └── page.tsx       # 主页面
├── bin/               # 命令行入口脚本
├── build/             # 构建辅助
├── components/        # React 组件（AppShell、ChatWindow、FileExplorer、DSH 面板等）
├── docs/              # 文档（agents/ 架构设计、dsh/、worktrees、i18n 等）
├── electron/          # Electron 桌面壳（main.cjs / preload.cjs / bridge.cjs）
├── hooks/             # React hooks
├── lib/               # 核心逻辑库（含测试 .test.mjs）
│   ├── team/          # 多 Agent 项目组 Runtime（EventSourcing / Workflow / Executor）
│   ├── plugins/       # 插件适配层（DSH 等）
│   ├── i18n/          # 国际化资源
│   ├── *.ts           # 会话、文件访问、changed-files、KET 桥等
│   └── *.test.mjs     # 核心逻辑单元测试（node:test）
├── packages/          # 内部 npm 包（pi-memory-zh）
├── pi-web-uploads/    # 数据目录（上传、AI 编辑产物、.internal 内部状态）
├── public/            # 静态资源
├── release/           # 打包产物（win-unpacked 等）
├── scripts/           # 构建/打包脚本（package.mjs、dev-electron.mjs、gen-icons.mjs）
├── tools/             # 工具脚本（当前为空，预留）
├── .agents/skills/    # 团队技能（browser-control、sheet-edit、univer-cli、web-preview 等）
├── AGENTS.md          # AI 协作约定（核心铁律 + 速览 + 索引）
├── electron-builder.yml  # Electron 打包配置
├── package.json       # 依赖与脚本（dev / dev:electron / pack:*）
└── tsconfig.json      # TypeScript 配置
```

## 三、核心目录统计（2026-08-26 实测）

| 目录 | 文件数 | 说明 |
|------|--------|------|
| app/ | 91 | App Router 页面 + API 路由（app/api/ 下覆盖 agent/auth/browser/dsh/sessions/teams/univer 等）|
| lib/ | 173 | 核心逻辑（含 lib/team/ 32 个文件 + 大量 .test.mjs 单测）|
| components/ | 45 | UI 组件 |
| hooks/ | 14 | React hooks |
| electron/ | 3 | 桌面壳主进程/预加载/桥接 |
| docs/ | 25 | 架构设计 + 使用文档（docs/agents/ 5 篇）|
| scripts/ | 3 | 打包/开发/图标脚本 |

## 四、关键模块速览

1. **app/api/** — 后端 API 路由域：会话（sessions）、文件（files/open-file）、浏览器桥（browser/*、browser/control/*）、
   上传、模型配置（models-config：catalog/discover/test）、插件（plugins、dsh/*）、团队（teams/*、teams/runs/*）、
   univer（view/edit-commit/merge/worktree-*/writeback/export）、git、worktrees、vision、terminal 等。
2. **lib/** — 核心能力：`changed-files.ts`（AI 改动卡片）、`ket-bridge.ts`（加密表格桥）、
   `provider-listing.ts`（模型提供商）、`model-scope.ts`（模型作用域）、`rpc-manager.ts`（RPC 会话）。
3. **lib/team/** — 多 Agent 项目组 Runtime：EventStore（events.jsonl 唯一事实来源）+
   RunManager + WorkflowEngine + ContextEngine + PiAgentExecutor + 受控工具集。
4. **electron/** — Electron 壳：`main.cjs` 内置 Next 服务（ELECTRON_RUN_AS_NODE 启动）、
   原生右侧浏览器（WebContentsView）、KET/WPS 桥。
5. **docs/agents/** — 架构参考：architecture.md / file-map.md / design-decisions.md / formats.md / team-runtime.md。

## 五、注意事项（团队协作约定）

- 开发期间**禁止 `next build`**（污染 `.next/`），打包走独立目录 `.next-pkg`（`PI_WEB_DIST_DIR`）。
- 每次改动必须过 `tsc --noEmit` + `npm run lint` 再交付。
- 右侧浏览器仅 Electron 模式可用（`npm run dev:electron`）。
- 多 Agent 项目组：events.jsonl 是唯一事实来源，Agent 只能通过受控工具
  （team_handoff / team_create_task / team_complete_task / team_add_artifact / team_record_decision）影响状态。
