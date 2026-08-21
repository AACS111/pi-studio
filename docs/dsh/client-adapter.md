# DSH Client Adapter — 落地状态与前端渲染路径

本文记录 DSH client 插件（浏览器端 Cordis 插件）适配到 Pi Studio 的进度与
剩余路径。原则（用户定义）：**DSH 只是插件生态来源，Pi Studio 才是最终宿主**；
DSH client 插件不知道 Pi，它只看到 DSH 的 `ctx`，Pi 侧提供 client 服务的映射。

## 已落地（服务端链路，本次完成）

```
安装 DSH client 插件
    ↓
dsh-plugin-store.ts           npm 安装到隔离 store（含核心服务包）
    ↓
dsh-detect.ts                 识别 dsh.client manifest + client seam（不阻塞安装）
    ↓
dsh-client-adapter.ts         读 dsh.client / exports["./client"] → 注册 Pi UI 扩展
    ↓
lib/plugins/ui/ui-registry.ts 扩展元数据（挂 globalThis）
    ↓
/api/plugins/ui               GET 列出扩展
    ↓
components/PluginHost.tsx     前端渲染（ActivityBar rail 条目 + 面板）
```

- `dsh-client-contract.ts` 固化了 client 契约（`dsh.client` manifest、
  `window.__ModuleLoader__`、`{apply,inject}` 导出、client 服务名清单、
  `DSH_CLIENT_SEAM_MAP` 映射表）。
- 纯 client UI 插件（如 `@linxin666/dsh-client-ui-task-board`）现在
  `detectDshPackage` 判定 `adaptable: true`，安装后其 sidebar 条目出现在
  Pi ActivityBar（元数据层闭环）。
- 彻底移除「启动 DSH Web 塞右面板」退路：`lib/dsh-ui-runtime.ts`、
  `/api/dsh/ui`、DshMarketPanel 的 openUi 按钮全部删除。

## 待落地（前端渲染真实 client UI）

元数据层已打通（DSH client 插件 → Pi Sidebar Extension Point），但**点击
sidebar 条目后渲染插件真实 React UI** 仍需以下 5 步。这是深水区，因为
client 插件深度绑定 DSH Web GUI（`ctx.slots.inject` + 直接 DOM 操作）。

### 1. 浏览器端模块加载器（window.__ModuleLoader__）

client.js 是 UMD：`window.__ModuleLoader__.load({id, factory})`，factory 里
`require("react")` / `require("@deepseek-ai/dsh-client-runtime/client")`。
Pi 需在客户端提供该加载器，解析：
- `react` / `react-dom/client` → Pi 前端已打包的 React（需暴露运行时引用）
- `@deepseek-ai/dsh-client-runtime/client` 等 → 由 Pi 提供替代实现（见第 3 步）

### 2. 让 client.js 可被前端加载

服务端 store 目录（`<internal>/dsh-plugins/node_modules/<pkg>/lib/client.js`）
需通过一个受控 API 暴露给前端（如 `/api/dsh/client-script?id=...`），并做
路径白名单校验（只允许已安装插件的 client 入口）。

### 3. client 服务的 Pi 实现（DSH_CLIENT_SEAM_MAP）

每个 client 服务写一个 Pi 实现（浏览器端 Cordis Service 或轻量对象）：
- `slots` → Pi UI Extension Point（`lib/plugins/ui/ui-registry` 的运行时版）
- `sessions` → `/api/sessions`（list / binding / open）
- `workspaces` → `/api/worktrees`
- `connection.api.*` → `/api/*` RPC（agentPresets / sessions.history）
- `settingsScope` → Pi settings.json
- `locale` → Pi i18n

### 4. 浏览器端 Cordis runtime

client 插件是 Cordis 插件（`{apply, inject}`），需要 `new Context()` +
`ctx.plugin(...)` 在浏览器端跑。`@deepseek-ai/cordis` 是否可在浏览器端
直接使用需验证（若依赖 Node API，则需一个最小 fiber 实现）。

### 5. slots.inject → Pi UI 注册

`ctx.slots.inject(name, factory)` / `ctx.slots.register(descriptor, Component)`
翻译成 Pi 的运行时 UI 注册，把组件挂到 PluginHost 的渲染容器。

> 注意：部分插件（如 task-board 的 `mountSidebarEntry`）直接操作 DSH Web GUI
> 的 DOM（`sidebarRoot()` / `MutationObserver` / `[data-dsh-taskboard-entry]`）。
> 这类「脏」插件需要 DOM 兼容层，或标记为「不完整兼容」。真正的
> `ctx.slots.inject` 型插件（走 slots 服务而非手摸 DOM）才能无痛适配。

## 建议的第一个验证目标

找一个**只依赖 `slots` + `locale`**、不直接摸 DOM 的简单 client 插件
（或自写一个最小 DSH client 插件作为 fixture），跑通第 1-5 步最小闭环，
再逐步扩展到 sessions/workspaces/connection。
