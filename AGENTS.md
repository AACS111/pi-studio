# Pi Studio — 开发笔记

> 本项目是 **Pi Studio**（`@aacs111/pi-studio` v0.8.6），基于 [agegr/pi-web](https://github.com/agegr/pi-web)
> 二次开发：保留原 Web UI 的全部能力，新增 **Electron 桌面壳**、**原生右侧浏览器控制（Semantic Browser V2）**、
> **Univer 表格深度集成**（查看/在线编辑/worktree/写回/加密解密/压缩）、**上传管理器**、
> **i18n（en/zh-CN）**、**PWA**、**Git 集成**、**项目信任**、**skill 安装/更新/锁定**、**模型目录/发现/测试**、
> **视觉描述**、**安全加固**（CSRF/Host/路径/可选 Basic Auth）、**性能优化**（聊天懒加载、undici 空闲超时）等。

---

## Quick Start

```bash
npm run dev            # 浏览器模式，127.0.0.1:10141（见 package.json 的 dev script）
npm run dev:electron   # Electron 壳 + dev server（scripts/dev-electron.mjs）
npm run dev:lan        # 局域网模式 0.0.0.0:30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`
Lint: `npm run lint`
**开发期间永远不要跑 `next build`** — 它污染 `.next/` 并搞坏 `npm run dev`。打包构建走独立目录 `.next-pkg`（`PI_WEB_DIST_DIR`），互不干扰。

### 打包桌面应用

```bash
npm run pack:dir       # 只生成 release/win-unpacked（快速验证）
npm run pack:portable  # 单文件便携版 .exe
npm run pack:nsis      # 安装版 .exe
npm run pack:msi       # .msi
npm run pack           # 安装版 + 便携版
```

- `scripts/package.mjs` 自动设置 `PI_WEB_DIST_DIR=.next-pkg` 和国内镜像（electron-builder-binaries / electron），GitHub 不可达时不会卡下载。
- `electron-builder.yml`：`asar: false`（内置服务要读真实文件路径）、`npmRebuild: false`（原生依赖均为预编译产物）。首次打包需联网拉 nsis/winCodeSign（已配镜像）。
- 打出来的 exe 用 `electron/main.cjs` 以「本 exe + `ELECTRON_RUN_AS_NODE=1`」方式启动内置 Next 服务（随机空闲端口，只监听 127.0.0.1）。

---

## 架构

### 两种运行形态

**浏览器模式（npm run dev / next start）**：直接访问 Next 服务，右侧浏览器为沙箱 iframe（`/api/browser/proxy` 代理去 frame 限制）。

**Electron 桌面模式（electron/main.cjs）**：

```
Pi Studio.exe (Electron main)
  ├─ spawn(本 exe + ELECTRON_RUN_AS_NODE=1 → next start，随机端口，127.0.0.1)
  ├─ BrowserWindow（UI 主窗口，加载服务地址）
  ├─ WebContentsView 池（右侧浏览器：每个网页标签一个 WebContentsView，仅一个可见）
  │    └─ bridge.cjs 启动 HTTP 桥（127.0.0.1 随机端口）暴露语义接口 /snapshot /execute /open ...
  ├─ CDP 远程调试端口（默认 9222，仅 127.0.0.1；PI_WEB_CDP_PORT 可改，设 0 关闭）
  └─ 退出时结束服务子进程（含其 worker 树 / univer daemon）
```

### 请求链路（与 pi 一致，浏览器/桌面通用）

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session 浏览**（只读）：直接读 `.jsonl`（`lib/session-reader.ts` + SDK `SessionManager`），不创建 AgentSession。
**发消息**：`startRpcSession()`（`lib/rpc-manager.ts`）进程内创建 AgentSession。

---

## 文件地图

### API 路由（`app/api/`，共 60+ 个）

**Agent / Session**
```
agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? } 创建会话
agent/[id]/route.ts             GET state | POST 任意命令
agent/[id]/events/route.ts      GET SSE 事件流
agent/[id]/bash-output/route.ts GET 会话引用的 bash 输出临时文件（pi-bash-*.log，系统 tmpdir）
agent/running/route.ts          GET 当前运行中的 session id
agent/running/events/route.ts   GET 运行中 id 的 SSE 流
sessions/route.ts               GET 会话列表
sessions/[id]/route.ts          GET/PATCH/DELETE 会话（含级联重挂子会话）
sessions/[id]/context/route.ts  GET ?leafId= — 指定叶子节点的上下文
sessions/[id]/export/route.ts   GET 导出的 HTML
sessions/[id]/auto-name/route.ts POST 用 LLM 自动生成会话标题（lib/session-title.ts）
sessions/[id]/state/route.ts    GET AgentSession 运行时状态快照（running / thinkingLevel / isCompacting）
sessions/[id]/entries/[entryId]/thinking/route.ts GET 指定条目的 thinking 块
```

**Auth / 模型**
```
auth/all-providers/route.ts      GET API-key 提供商列表
auth/api-key/[provider]/route.ts GET/POST/DELETE 提供商 API key 状态/存储
auth/login/[provider]/route.ts   GET OAuth/device-code SSE | POST 手动码
auth/logout/[provider]/route.ts  POST OAuth 登出
auth/providers/route.ts          GET OAuth 提供商列表
models/route.ts                  GET { models, modelList, defaultModel }（含 enabledModels 作用域、thinking 固定、警告）
models-config/route.ts           GET/PUT ~/.pi/agent/models.json
models-config/catalog/route.ts   GET models.dev 定价预设
models-config/discover/route.ts  POST 拉取已配置提供商的上游模型列表
models-config/test/route.ts      POST 测试配置的模型/提供商（app/api/models/test/ 不是真实路由）
```

**文件 / CWD / Git / 上传**
```
cwd/browse/route.ts              GET 目录浏览（Windows 盘符选择、可读子目录列表）
cwd/validate/route.ts            POST 校验/选择一个 cwd
default-cwd/route.ts             POST 创建 ~/pi-cwd-YYYYMMDD
files/[...path]/route.ts         GET 文件内容（受允许根列表限制，见下）
files/save/route.ts              POST 写回文件（base64，25MB 上限）
files/reveal/route.ts            POST 在系统文件管理器中打开文件所在文件夹（Explorer /select，spawn 分离不等待；
                                 .univer 优先定位同名 .xlsx，见 lib/univer-paths.ts）
files/open-external/route.ts     POST 用系统默认程序打开文件（cmd start / open / xdg-open；
                                 .univer 优先打开同名 .xlsx）
open-file-request/route.ts       agent 推送文件到右侧面板的标记（UI 轮询，作用一次后清除；类似 /api/browser 的文件版）
file-index/route.ts              GET 文件模糊索引（git ls-files 优先，回退 readdir）
open-file/route.ts               GET/POST 右侧面板激活文件标记（agent 默认编辑目标）
git/diff/route.ts                GET 单文件 unified diff（changed-files 卡片的 +N/-M 统计）
git/status/route.ts              GET git 仓库状态
home/route.ts                    GET 用户主目录
uploads/route.ts                 GET 上传列表 | POST 上传（含 .xlsx→.univer 转换）| DELETE 删除 | PATCH 改存储目录
worktrees/route.ts               GET/POST/DELETE git worktrees
```

**浏览器（右面板）**
```
browser/route.ts                 GET/POST/DELETE 网页预览标记（agent 推页面到面板）
browser/control/[...path]/route.ts 流式透传到浏览器控制桥（Electron 原生 WebContentsView；
                                    npm run dev 纯浏览器模式无桥，返回 502）：
                                    /open /url /content /snapshot /screenshot /screencast /input
                                    /click /type /fill /select /check /press /scroll /wait /assert
                                    /execute (批量) /evaluate — 语义接口仅 Electron 原生模式提供
```

**Univer（表格）**
```
univer/view/route.ts             GET .univer → xlsx 字节（headCommit 校验的导出缓存）
univer/export/route.ts           GET 导出 .xlsx/.csv 下载
univer/writeback/route.ts        POST 把 .univer 写回原 .xlsx（经 KET/SheetJS 重建）
univer/edit-commit/route.ts      POST 提交在线单元格编辑 → worktree（或经隐藏 pi-auto 暂存上主干）
univer/worktree-create/route.ts  POST 创建草稿 worktree（默认名 u-<6随机数>）
univer/worktree-delete/route.ts  POST 永久删除未合并 worktree（直接 SQLite）
univer/worktrees/route.ts        GET worktree 列表 + 提交 + userSeqs（直接 SQLite 读）
univer/merge/route.ts            POST 合并 worktree 到主干（agent 永不自动合并！）
univer/discard/route.ts          POST 丢弃 worktree（CLI）
univer/from-xlsx/route.ts        POST 上传的 xlsx → .univer（导入后做一次体积压缩）
```

**Skill / 插件 / 信任**
```
plugins/route.ts                 GET/POST 包插件管理（SettingsManager + DefaultPackageManager）
skills/route.ts                  GET/PATCH 已加载 skills 与 disable-model-invocation
skills/install/route.ts          POST 通过 npx skills add 安装
skills/search/route.ts           GET/POST skills.sh 搜索
skills/check/route.ts            POST 检查 skill 包更新（git 浅克隆到系统 tmpdir 比对）
skills/update/route.ts           POST 更新 skill 包
project-trust/route.ts           POST 信任项目（~/.pi/agent/trust.json；busy 时拒绝，之后销毁该 cwd 的会话）
vision/describe/route.ts         POST 用视觉模型描述图片（90s 超时，2048 tokens）
update/check/route.ts            GET 检查 pi-studio 应用自身版本（npm registry latest vs 本地，lib/update-manager.ts）
update/run/route.ts              POST 全局安装模式自更新应用（npm install -g --prefix，需重启生效；源码模式拒绝）
```

### `lib/`

**核心运行时**
```
rpc-manager.ts        AgentSessionWrapper + registry + startRpcSession（globalThis.__piSessions）
session-reader.ts     SessionManager 封装 + 路径缓存 + buildSessionContext 适配
agent-client.ts       类型化 fetch 助手
normalize.ts          normalizeToolCalls() — 文件格式字段名 → 我们类型的映射
pi-types.ts           本地结构类型
types.ts / api-types.ts  共享类型
tool-presets.ts       PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
startup-preferences.ts 新会话模型/思考级别的持久化（不重放 set_model/set_thinking_level）
model-scope.ts        enabledModels 作用域（委托 SDK resolveModelScopeWithDiagnostics）
models-cache.ts       模型列表缓存（信任变更时失效）
model-catalog.ts      models.dev 预设目录
model-discovery.ts / model-discovery-auth.ts  上游模型发现（tmpdir 里 mkdtemp 存凭证）
provider-listing.ts / provider-listing-runtime.ts  能力驱动（非 id 驱动）的提供商列表
provider-credential-store.ts  按文件锁安全删凭据
```

**会话文件**
```
session-path.ts / session-title.ts / session-file-references.ts(+core) / compaction-summary.ts
changed-files.ts      每轮编辑/写入文件汇总（edit/write 工具 input 字段是 path 不是 filePath）
```

**存储 / 上传**
```
storage-config.ts     数据目录解析：PI_WEB_UPLOADS_DIR > .pi-web-config.json uploadsDir > 项目默认
                      pi-web-uploads/；.internal/ 存内部状态；旧数据 (~/.pi/agent/pi-web-*) 启动时迁移一次
uploads.ts            上传隔离存储（默认上限 300MB，按 mtime 从旧到新清理；文件名消毒防穿越）
atomic-file.ts        原子写（tmp+rename）
```

**浏览器（右面板）**
```
browser-proxy.ts       URL 规范化辅助（normalizeUserUrl）
```

**Univer**
```
univer-cli.ts         专属 univer daemon（UNIVER_HOME=<数据目录>/.internal/univer 隔离全局 ~/.univer）；
                      优先项目固定入口 node_modules/univer-cli/bin/univer.js（直调 node，避开 cmd 引号坑），
                      回退全局安装；首次调用加锁暖机；runUniver 仍重试一次兜底
univer-db.ts          直接 SQLite 读（busy_timeout=8000ms，.univer 回滚日志模式下写锁可持 11-23s）
univer-dims.ts        从 SQLite 快照读每表行/列数（替代 ~8s 的 inspect）
univer-unit-id.ts     按 path+mtime 缓存 unitId（文件重建后 id 会变）
univer-paths.ts       外部目标解析：.univer → 同名 .xlsx（reveal/open-external 用）
univer-view-cache.ts  xlsx 导出缓存（30min TTL + 同 key 合并 + edit-commit 预热；导出文件写系统 tmpdir）
univer-compact.ts     导入后压缩：删除已合并 worktree 的 seed/artifact 冗余行（34MB→9.8MB 量级）
univer-user-edits.ts  「u」前缀在线编辑提交的旁路标记（<数据目录>/.internal/pi-web-univer-user-edits.json）
ket-bridge.ts         加密 .xlsx 解密（WPS KET COM：首选 SaveAs 51，兜底 COM 取数重建；结果按
                      源路径|大小|mtime|密码 缓存到内部目录，上限 32 个 / 7 天）。2026-08-17 实测修复：
                      WPS 12.0 的 SaveAs 输出必被 TSD 包裹（含普通文件，csv/xls/xlsb/xlsx 全包）、工作表级
                      COM 被拒（E_ACCESSDENIED，只能读 Application 级活动工作表）；PS 5.1 二维数组逐格索引
                      走反射慢路径（24780 格分钟级挂死，原实现在合并检测循环挂死）→ 必须 foreach 展平 1D；
                      ConvertTo-Json 大嵌套数组极慢 → 改 StringBuilder 紧凑行协议；无密码打开需密码文件时
                      必须显式传空串密码参数（缺参弹「文档已加密」模态框阻塞，DisplayAlerts 抑制不了）；
                      COM 返回数组维度可能 ≠ SpecialCells 行列（69x20 → 69x46）→ 以数组实际维度建网格防
                      越界；超时残留 et/wps 进程会阻塞后续所有 KET 调用 → 脚本上报 KET_WPS_PIDS + Node
                      finally taskkill /T /F 清理。提取重建 partial=true（仅活动表），sheetsTotal 给总数
```

**Skill / 插件**
```
skills-service.ts     DefaultResourceLoader + 信任门控加载
skill-lock.ts         ~/.agents/.skill-lock.json 安装来源标注（skills install 之后 /api/skills 列表要能识别）
skill-updates.ts      更新检查（git 浅克隆到 tmpdir 比对版本）
npx.ts                npx 运行器
```

**安全 / 网络**
```
request-security.ts   Origin/Host 校验（允许回环、IP 字面量、绑定 hostname、PI_WEB_ALLOWED_HOSTS）
path-security.ts      路径规范化/防穿越
web-auth.ts           可选 Basic Auth（用户名固定 pi；PI_WEB_PASSWORD 开启，timingSafeEqual 比较）
http-dispatcher.ts    全局 undici dispatcher：空闲 300s 超时 + 忽略内部 Client error（防进程被 EventEmitter error 打死）
bash-output.ts        bash 输出临时文件白名单解析（pi-bash-*.log 必须在系统 tmpdir 根，O_NOFOLLOW 防软链）
update-manager.ts     应用自身版本检查/自更新：npm registry latest vs package.json；仅全局安装模式可自动更新
                      （npm install -g --prefix <全局前缀>，源码模式提示 git pull && npm install）；npm-cli.js 按
                      npm_execpath → execPath 布局 → cmd /c npm root -g 顺序解析；globalThis 串行锁
pi-compat-check.ts     pi 引擎兼容性自检（自包含，可被 node 子进程 strip-types 直跑）：Theme 构造冒烟 +
                      依赖导出检查；THEME_FG/BG_KEYS 全量颜色表是 rpc-manager PlainTextTheme 的单一来源
                      （pi >= 0.84 Theme 构造缺键会 undefined.startsWith 崩溃）
```

**其他**
```
file-access.ts / allowed-roots.ts   /api/files 允许根列表
file-paths.ts / file-dirent.ts / file-types.ts / file-fuzzy.ts / file-links.ts / file-upload.ts / image-attachments.ts
directory-browser.ts / bounded-form-data.ts / clipboard.ts / ansi.ts
git-changes.ts / git-status.ts / git-types.ts
worktree.ts           worktree 解析与 git 操作（link 回主仓库 projectRoot）
chat-lazy-load.ts     聊天窗口虚拟化（每页 50 条，滚动距离保持）
terminal-input.ts     键盘事件 → 终端转义序列
custom-ui-terminal.ts 无头 TUI 终端（92x40，扩展用）
draft-store.ts        本地草稿
i18n/                 messages/{en,zh-CN}.ts + registry + format（浏览器 locale 自动检测）
markdown.ts           markdown 辅助
pi-studio-options.ts / node-version.js  CLI 启动参数与 Node 版本门禁（>=22.19）
project-trust.ts      hasTrustRequiringProjectResources + ProjectTrustStore 封装
```

### `components/`

```
AppShell.tsx           布局 + URL 状态 + tab 管理
SessionSidebar.tsx     会话树 + FileExplorer
ChatWindow.tsx         聊天组合 + 完成音包装 + 懒加载渲染 + changed-files 卡片装配点
ChatInput.tsx          输入栏 + 模型/思考/工具/紧凑控制
MessageView.tsx        单条消息渲染
BranchNavigator.tsx    会话内分支切换
ChatMinimap.tsx        滚动缩略图
MarkdownBody.tsx       markdown 渲染（含 katex/mermaid 支持）
MermaidBlock.tsx       mermaid 图渲染
TabBar.tsx             标签栏（Chat + 打开的文件 tab）
FileExplorer.tsx       侧栏文件树
FileViewer.tsx         文件内容 tab（.xlsx → XlsxViewer，.univer → UniverFileViewer，图片/文本等）
XlsxViewer.tsx         Univer sheets 查看器（core preset + OSS 插件 + fflate 解 zip 翻译 sheet XML 高级特性）
UniverFileViewer.tsx   .univer 文件查看器（轮询 + ackRevRef 就地同步 + scope 缓存）
univer-worker.ts       表格 worker（公式/筛选等）
WebViewer.tsx          右侧网页浏览器（iframe 代理 / Electron WebContentsView 双后端）
UploadsManager.tsx     上传管理弹窗（列表/删除/改存储目录/容量统计）
ModelsConfig.tsx       models.json 编辑弹窗
PluginsConfig.tsx      包插件弹窗
SkillsConfig.tsx       skills 加载/搜索/安装弹窗
ProjectTrustDialog.tsx 项目信任确认弹窗
DirectoryPicker.tsx    目录选择器（盘符/浏览）
ExtensionStatusBar.tsx 扩展状态条（ANSI 清洗）
ChangedFilesCard.tsx   助手消息下的变更文件摘要卡
GeneratedFilesCard.tsx  生成文件卡（.xlsx/.univer/文档/图片等交付物，每行支持右侧打开 /
                        打开所在文件夹 / 外部打开；.univer 的外部动作解析为同名 .xlsx）
PwaRegistration.tsx    Service Worker 注册
MobilePwaLayout.tsx    移动 PWA 布局
FileIcons.tsx          文件图标
```

### `hooks/`

```
useAgentSession.ts    消息 + 流式 + SSE + fork/navigate/对账逻辑
useAudio.ts            完成音 + AudioContext 解锁（localStorage: pi-sound-enabled）
useDragDrop.ts         拖放状态
useI18n.tsx            i18n context（localStorage: pi-locale）
useIsMobile.ts         响应式断点
useKeyboardShortcuts.ts 快捷键
useResizablePanel.ts   可拖拽分隔面板
useTheme.ts            主题
useViewportHeight.ts   视口高度（移动端地址栏）
```

### Electron（`electron/`）

```
main.cjs    桌面主进程：ELECTRON_RUN_AS_NODE=1 起 next start（随机端口）；WebContentsView 标签池；
            CDP 远程调试（9222）；下载目录；退出杀整棵子进程树
bridge.cjs  Semantic Browser V2 控制桥（HTTP，127.0.0.1 随机端口）：/snapshot /execute /open
            /select /fill /wait /assert 等语义接口，基于 executeJavaScript 注入评分定位器
preload.cjs WebContentsView 的 preload（网页侧桥接）
```

### 其他

```
bin/pi-studio.js        CLI 入口（node 版本门禁 + next 启动 + 端口/host/自动开浏览器）
scripts/package.mjs     打包（.next-pkg + electron-builder + 国内镜像）
scripts/dev-electron.mjs dev 模式 Electron
.agents/skills/          项目技能：browser-control / sheet-edit / univer-cli / univer-integrate / web-preview
docs/                    i18n.md / release.md / worktrees.md(.zh-CN.md)
proxy.ts                 Next middleware：API 的 Origin+Host 校验
instrumentation.ts       启动钩子：数据目录迁移 + undici dispatcher + univer daemon 暖机
```

---

## 关键设计决策与坑

### 右侧面板 open-file 标记（agent 约定）
- `AppShell` 在激活文件 tab 变化时上报 `/api/open-file`（按路径去重，只变更时发）。路由把 `{ filePath, updatedAt }` 持久化到 pi-studio 数据目录（默认 `<项目>/pi-web-uploads/.internal/pi-web-open-file.json`，位置可配置，见 `lib/storage-config.ts`），原子 tmp+rename 写。
- **约定：用户说「编辑这张表」又没点名文件时，默认编辑该标记记录的文件**（右侧查看器里打开的那个）。用 `GET /api/open-file` 或直接读标记文件；缺失/未设置就问用户。
- **上传存储**：上传文件、AI 编辑 .univer 产物、pi-studio 内部状态都在可配置数据目录（默认 `<项目>/pi-web-uploads/`，`.internal/` 存放 open-file 标记、user-edits 侧车、univer CLI home）。解析顺序：`PI_WEB_UPLOADS_DIR` env → `.pi-web-config.json` 的 `uploadsDir`（可在 UI 改）→ 项目默认。旧数据从 `~/.pi/agent/pi-web-*` 启动时迁移一次（`instrumentation.ts` → `migrateLegacyData()`）。

### Changed-files 卡片（每轮变更摘要）
- `extractChangedFiles()`（`lib/changed-files.ts`）扫描助手 turn 的 toolCall 块里的 `edit`/`write` 工具（input 字段是 `path` 不是 `filePath`），去重返回 `{filePath, kind}`。
- **非项目文件不显示（2026-08-12）**：两个提取函数都接受 `cwd` 参数，绝对路径在会话 cwd 之外（Temp 脚本、其他目录产物）一律过滤；相对路径视为项目内。`extractGeneratedFiles()` 额外只保留 `write` + 交付物扩展名（.xlsx/.univer/.csv/.docx/.pdf/.png/.md/…）供生成文件卡使用。
- **生成文件自动推右侧（2026-08-12）**：agent 生成表格后 `POST /api/open-file-request`（`{filePath,title?}`），AppShell 每 3s 轮询该标记并自动开文件 tab（作用一次后 DELETE），与 /api/browser 的网页预览同一模式。
- 卡片由 `ChatWindow` 渲染，**不在 MessageView 内**：assistant turn 被拆成折叠的 `ProcessDetailsGroup`（思考+工具调用）和独立最终回答消息。卡片必须放在**消息 footer 层**（回答文本下方、用量统计上方），否则会被折叠进 process group。
- 变更文件从**组内所有 assistant 消息**（`userIdx+1..endIdx`）收集，不只看最终回答。
- 每个文件的 `+N`/`-M` diff 统计从 `/api/git/diff` 惰性拉取并用 `parseUnifiedPatch` 解析。fetch effect 依赖**稳定的 `filesKey` 字符串**，绝不依赖 `files` 数组引用（父组件每次渲染重建数组 — 依赖它会导致 fetch 风暴打崩 dev server）。
- 流式尾部（`isLiveTail` + `streamingMessage`）也渲染卡片，让编辑实时可见。

### AgentSession 生命周期（`lib/rpc-manager.ts`）
- 每个 session id 一个 `AgentSessionWrapper`，挂在 `globalThis.__piSessions`（Next.js 热重载下 module 级 Map 会丢，globalThis 不会）。
- 空闲超时 10 分钟。并发的 `startRpcSession()` 共享单个启动 Promise（`globalThis.__piStartLocks`）。

### Fork 必须立刻销毁 wrapper
`AgentSession.fork()` **原地修改 wrapper 内部状态** — fork 之后 `inner.sessionId` 变成新会话的 id。如果 wrapper 还以旧 id 活在 registry 里，下一次请求会拿到已 fork 的状态，后续 fork 产生损坏的 `parentSession` 链。
**修复**：`send("fork")` 拿到 `newSessionId` 后先 `this.destroy()` 再返回。下次请求原会话时从原文件重新加载干净的 AgentSession。

### 两种分支，别混淆
- **Fork**（用户消息上的 Fork 按钮）：创建独立的新 `.jsonl` 文件，经 `parentSession` 头字段在侧栏树里显示为子节点。
- **会话内分支**（Continue 按钮 / BranchNavigator）：同一文件内 `navigate_tree`，多个条目共享同一个 `parentId`，切换走 `/api/sessions/[id]/context?leafId=`。

### 会话文件可整文件重写
`parentSession` 头字段**只是显示元数据** — 对聊天内容零影响，可安全 `writeFileSync` 整个文件（pi 自己迁移时也这么干）。删除会话时级联重挂子会话就靠它。

### ToolCall 字段归一化
pi 把 toolCall 块存成 `{type:"toolCall", id, name, arguments}`，而 `ToolCallContent` 用 `{toolCallId, toolName, input}`。`normalizeToolCalls()`（`lib/normalize.ts`）处理这个映射 — `session-reader.ts`（文件加载）和 `ChatWindow.handleAgentEvent()`（流式）都调用。

### 新会话工具预设
建会话时传 `toolNames[]`（`POST /api/agent/new`）。已有会话挂载时经 `get_tools` → `getPresetFromTools()` 推断预设。工具全禁用（`toolNames = []`）时，`rpc-manager.ts` 传空 allow-list 并强制 `agent.state.systemPrompt = ""`（启动/重载/资源发现之后都要设）。

### 新会话模型默认值
`GET /api/models` 从 `~/.pi/agent/settings.json` 读 `defaultModel`，`ChatWindow` 挂载时预选。显式的模型/思考级别选择在 AgentSession 构造时原子应用，随后 `lib/startup-preferences.ts` 持久化生效值**而不重放** `set_model`/`set_thinking_level`；隐式的 `enabledModels` 回退与思考固定不持久化。

### `enabledModels` 作用域
`enabledModels` 用 pi 的 `--models` 语法：minimatch glob 匹配 `provider/modelId` 或裸 `modelId`，非 glob 模式模糊匹配，可带 `:thinkingLevel` 后缀。**永远别把这些模式当字面字符串比较** — `lib/model-scope.ts` 委托 SDK 的 `resolveModelScopeWithDiagnostics()`，让 pi-studio 和 TUI 看到一致的模型列表；模式解析为空时回退全部模型。`startRpcSession()` 在创建 AgentSession 前解析作用域，原子传入初始模型、思考固定和 SDK 原生 `scopedModels`；`GET /api/models` 只用同一 helper 取选择器数据、`thinkingLevelPins` 和 `modelScopeWarnings`。

### 页面刷新中断流后 SSE 重连
`ChatWindow` 挂载时先 `GET /api/agent/[id]`；若 `state.isStreaming === true` 自动重连 SSE，并同步 `thinkingLevel` / `isCompacting`。

### Compaction SSE 事件
新 pi 发 `compaction_start`/`compaction_end`，旧版发 `auto_compaction_start`/`auto_compaction_end`。`handleAgentEvent` 两套都收，保证 `isCompacting` 同步。手动 compact 是阻塞 POST — 按钮在响应返回前保持禁用。

### 运行状态轮询 + 对账
- 侧栏每 2.5s 轮询 `/api/agent/running`（标签页可见时；后台标签暂停，会话列表响应作初始回退）。
- `useAgentSession` 把每条会话的 SSE 当主通道，每次 prompt 前打开。`prompt_done` 完成当前 UI 阶段与通知，但空闲 SSE 保持 30s 宽限窗口供下次 prompt 复用。`agent_start` 取消关闭定时器；`agent_settled` 收尾扩展注入的、没有 wrapper 级 `prompt_done` 的运行并开新宽限窗。**别在第一个 `agent_end` 就关闭**：重试、compaction、扩展排队消息会延续同一逻辑 prompt。
- 运行期间周期调 `GET /api/agent/[id]` 并在 `visibilitychange`/`online` 时对账，修复后台标签/半开连接的漏事件。
- Prompt 运行用单调 run id；旧 run 的迟到 SSE 或慢对账响应必须忽略，防止复活过期流式气泡。

### Worktrees 与项目分组
- `lib/worktree.ts` 把链接的 worktree 顶层解析回主仓库 `projectRoot`；`listAllSessions()` 把它挂到每个 `SessionInfo`，同一仓库的所有 worktree 在侧栏里归组。
- worktree 操作由 `/api/worktrees` 服务，受 `/api/files` 相同的允许根规则保护。
- 新 worktree 建在 `<repoRoot>-worktrees/<sanitized-branch>`；已有分支复用，否则 `git worktree add -b`。
- 删除脏 worktree 返回 `409 { dirty: true }`，UI 询问后 `force` 重试。
- cwd 指向已删 worktree 的会话回退归到主项目，不产生幽灵项目行。

### Univer 查看器就地同步（`.univer` 文件）
- **每个文件一个 Univer 实例**。`XlsxViewer` 在 scope 切换间保活；scope 变化（分支切换 / 外部 `univer execute` 提交）**就地 diff 应用**（单元格 v/t/f/s 走 `FRange.setValue`，合并走 `merge()` / `sheet.command.remove-worksheet-merge`），不是销毁重建。只有结构性变化（sheet 集合/名称/尺寸、CF/校验/筛选资源、或 >8000 个变更单元格）才回退重建。
- **解析 scope 缓存**（`loadScopeData`/`warmScopeData`）：每个 scope 的解析工作簿按 `scopeKey = <file>::wt:<id>::<headCommit>`（或 `::trunk::<mtime>`）缓存。`UniverFileViewer` 的轮询只在**正在看的** scope 内容外部变化时才推进 `ackRevRef` — 其他 worktree 的提交、状态变化、用户自己的自动保存（`ownSaveRef`：worktree=headCommit seq，trunk=文件 mtime）永不重同步网格。
- `/api/univer/worktrees` 返回 `trunkRev`（文件 mtime）供前端缓存 key；合并会使其失效（无论看的是什么）。
- **Agent 铁律：永不自动合并 worktree。** 在 worktree 上编辑 → `worktree ready` → 停下，用户自己在查看器里点「合并到主干」或明确要求。sheet-edit 技能强制这条。
- **验证纪律**：每个改动必须过 tsc + eslint + headless 浏览器往返（trunk→worktree→trunk 带样式断言）再交付 — 绝不把未验证状态交给用户（浏览器可能跑着旧 chunk/scope 缓存）。坑位清单见 sheet-edit 技能的交付流程铁律/常见坑（`setValue` 合并语义、`s:null` 是唯一清样式方式、SheetJS 丢对齐、`getCellData().s` 是样式 id 要读 `wb.save().styles[id]`、daemon 文件锁、dev 端口 10141）。

### 加密 xlsx（KET 桥）
标准 OOXML 加密 / WPS TSD 加密 / WPS 结构加密的 `.xlsx` 无法被 fflate/SheetJS 解析时走 `lib/ket-bridge.ts` 的 WPS KET COM 自动化（ProgID `Ket.Application`）：首选 `Workbooks.Open` → `SaveAs(FileFormat=51)` 另存为标准 xlsx 并校验 PK 魔数；受限 WPS 365 企业版强制 TSD 容器时兜底 COM 按 Range 取数 + SheetJS 重建（只还原活动工作表）。解密结果按「源路径|大小|mtime|密码」缓存（上限 32 个 / 7 天）。KET 调用 90s 超时防弹窗挂死。

### 文件访问允许列表
- `/api/files` 刻意不是通用文件系统浏览器。允许根来自：会话 cwds、其解析出的项目根、`~/pi-cwd-*`、以及显式 `allowFileRoot()` 添加的根。
- `/api/cwd/validate`、`/api/default-cwd`、`/api/worktrees` 在产生新可浏览位置时调用 `allowFileRoot()`。
- `/api/files/save`、`/api/git/*`、`/api/file-index` 走同一套 `isFilePathAllowed` 校验。

### Plugins 和 skills
- `/api/plugins` 用 pi 的 `SettingsManager` + `DefaultPackageManager` 做全局/项目包安装、移除、更新、启停。禁用时把该包条目的 `extensions/skills/prompts/themes` 数组写成空。
- `/api/skills` 用 `DefaultResourceLoader`，settings 路径、包 skills、项目 `.agents/skills` 与运行时视角一致。
- **项目技能在 `.agents/skills/`**（browser-control / sheet-edit / univer-cli / univer-integrate / web-preview），随仓库分发。只在项目被信任（`~/.pi/agent/trust.json`，与 pi CLI 共享；`/api/project-trust` 记录，busy 时拒绝并事后销毁 cwd 会话）后加载。新增 `.agents/skills` 的项目会翻转 `hasTrustRequiringProjectResources` — 未信任项目完全跳过（`projectResourcesLoaded: false`）。
- skill 开关只改目标 `SKILL.md` 的 `disable-model-invocation` frontmatter 键，保持外科手术式修改以保留用户格式。
- `/api/skills/install` 走 `npx skills add ... --agent pi`；项目级安装用所选 cwd。`/api/skills/check` 与 `/api/skills/update` 用 git 浅克隆到系统 tmpdir 做版本比对。

### Auth 和模型配置
- `ModelsConfig` 把 `~/.pi/agent/models.json` 的模型与 pi `AuthStorage`/`ModelRegistry` 的提供商认证状态合并展示。
- 提供商列表是**能力驱动，绝不 id 驱动**：`lib/provider-listing.ts` 依据 `auth.apiKey.login` / `auth.oauth` 加已存凭据类型决定归属，双认证提供商（现在 anthropic 与 github-copilot — SDK 版本之间声明会变，别按 id 猜）恰好出现一次、绝不双列。
- auth.json 每个提供商**一个**凭据，`ModelRuntime.logout()` 删掉它。删除路由因此用 `removeStoredCredentialIfType()` 在 pi auth 存储同一文件锁下比较再删。`ModelsConfig` 在任何认证变化后**刷新两个列表** — 只刷一个会让双认证提供商渲染两次。
- OAuth/device-code/manual-code 流由 `GET /api/auth/login/[provider]` SSE 流式输出；manual code 响应 POST 回短时 token 存 `globalThis.__piLoginCallbacks`。
- API-key 路由经 `AuthStorage` 存/删，状态端点绝不返回裸 key。
- 模型测试路由是 `app/api/models-config/test/route.ts`；`app/api/models/test/` 不是真实路由。

### 完成音
- `hooks/useAudio.ts` 把开关存 `localStorage` 的 `pi-sound-enabled`，复用一个 `AudioContext`。
- 浏览器自动播放策略要求从用户手势解锁；`ChatInput` 在交互控件上调用解锁 hook，`ChatWindow` 从 `onAgentEnd` 播放提示音。

### 导出的会话 HTML
`/api/sessions/[id]/export` 委托 pi 导出助手，再把生成 HTML 里的递归树 helper 补丁成迭代版本，避免极深线性会话把浏览器调用栈打爆。

### Electron 桌面壳
- `main.cjs` 用 `ELECTRON_RUN_AS_NODE=1` 让 exe 扮演 node 启动 `next start`（随机端口 / `PI_WEB_PORT` 固定；dev 模式 `PI_WEB_SERVER_MODE=dev` 走 10141）。子进程（含 univer daemon）继承该 env。
- 打包后数据目录移到 `%APPDATA%/Pi Studio/pi-web-uploads`（Program Files 不可写）。
- **dev 模式必须用独立 userData**：两者都 `app.setName("Pi Studio")`，userData 按 app 名惰性解析；若不重定向，dev 版会落到与 exe 版相同的 `%APPDATA%/Pi Studio`，导致单实例锁冲突（exe 在跑时 `dev:electron` 的 `requestSingleInstanceLock()` 返回 false → `app.quit()` 假死，窗口永远不出现）且数据目录互相污染。修复：`SERVER_MODE==="dev"` 时 `app.setPath("userData", ...)` 重定向到 `%APPDATA%/Pi Studio Dev`，**顺序必须是先 setName 再 setPath**（首次访问 `getPath` 会缓存路径，setName 会改写它）。
- 右侧浏览器 = WebContentsView 池，每网页标签一个，仅一个可见；`bridge.cjs` 起 HTTP 桥暴露语义控制接口；CDP 端口 9222（`PI_WEB_CDP_PORT` 改/关，dev 脚本默认 9223 避开 exe）。
- 退出时按 pid 树杀服务子进程；下载目录统一收进 `browserDownloadsDir`。

### 浏览器控制桥（Semantic Browser V2）
- **仅 Electron 模式**：右侧浏览器由 Electron 内嵌 WebContentsView 渲染，`bridge.cjs` 用 `executeJavaScript` + CDP 落到同一页面，语义接口（/snapshot /execute /select /fill /check /wait /assert）只在此模式提供。snapshot 返回 ref/role/name/value；评分定位器顺序 精确文本 > aria > placeholder > testid > contains，歧义返回 409 + 候选。
- **npm run dev 纯浏览器模式不支持右侧浏览器**：无桥时 `/api/browser/control/*` 返回 502（提示改用 dev:electron / 打包应用），面板显示「仅 Electron 支持」。
- `/api/browser/control/[...path]` 把请求流式透传到桥，agent 通过它观察并操作右侧页面。桥地址从 `PI_WEB_BROWSER_BRIDGE_URL` env 或数据目录 `pi-web-browser-bridge.json` 标记读取（Electron 主进程启动 bridge 时写入）。

### 安全模型（proxy.ts）
- `/api/*` 请求校验 Origin（同源或可信列表）+ Host；非 API 页面只校验 Host。
- `PI_WEB_PASSWORD` 开启 Basic Auth（用户名固定 `pi`，sha256 + timingSafeEqual）；`PI_WEB_ALLOWED_HOSTS` 允许可信反代的外部 hostname。
- 上传文件名消毒（`sanitizeUploadName` 防穿越）；`/api/files/save` 走允许根校验。

### bash 输出临时文件
- 大命令输出由 pi 写到系统 tmpdir 的 `pi-bash-*.log`，`/api/agent/[id]/bash-output` 提供读取（内联显示限 5MB，下载走流式）。路径必须位于 tmpdir 根且文件名匹配白名单（`lib/bash-output.ts`），`O_NOFOLLOW` 打开防符号链接，且必须被该会话真实引用（`lib/session-file-references.ts` 扫会话条目）。
- 这些文件在系统 Temp 里不随会话结束自动清理，属已知行为；定期清空 `%TEMP%` 下 `pi-bash-*`、`univer-view-*`、`pi-web-*`、`pi-cdp-*`、`piweb-cdp-*` 前缀文件即可（详见下方「Temp 目录卫生」）。

### 性能与稳定性
- **undici dispatcher**（`lib/http-dispatcher.ts`）：`instrumentation.ts` 启动时调 `configureHttpDispatcher()`，全局 fetch 走带 300s 空闲超时（`DEFAULT_HTTP_IDLE_TIMEOUT_MS`）的 Client，并吞掉终止响应体时的内部 Client error（否则 EventEmitter error 直接打死 Next 进程）。超时是 `configureHttpDispatcher(timeoutMs)` 的代码级参数（`0` 禁用），非环境变量。
- **聊天懒加载**（`lib/chat-lazy-load.ts`）：默认只渲染末尾 50 条，滚到底加载上一页 50 条，保持滚动距离不跳。
- **univer 读取**：`/api/univer/view` 有 30min TTL 导出缓存 + 同 key inflight 合并 + edit-commit 后预热；尺寸/提交信息直接 SQLite 读，不跑慢 CLI。

### Temp 目录卫生
pi-studio 相关临时产物都落在系统 Temp（`%TEMP%` / `os.tmpdir()`），按前缀可分：
- `pi-bash-*.log` — 大命令输出缓存
- `univer-view-*.xlsx` — univer 导出缓存文件
- `pi-web-model-discovery-*` / `pi-web-skill-check-*` — 模型发现与 skill 更新检查的临时目录
- `pi-cdp-*` / `piweb-cdp-*` — pi/pi-studio 的 Chrome CDP user-data 目录（每个约 20-40MB，用后残留）
- `cdp-test-profile` / `piweb-cdp-smoke-*` / `e2e-profile` 等 — 测试/验证临时 profile

全部可在 pi-studio 未运行时安全删除。若想自动清理：在 dev 启动脚本（`restart-dev.ps1` 或 dev 前置命令）里加一步删除这些前缀的旧文件即可；不要删正在运行的会话可能仍要读的 `pi-bash-*`（仅删除超过若干小时的）。

---

## Pi Session 文件格式

位置：`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`SessionContext.entryIds[]` 与 `messages[]` 平行 — 把每个展示消息映射回 `.jsonl` entry id，用于 fork 和 navigate_tree。

---

## CSS Variables（`app/globals.css`）

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

## 环境变量一览

| 变量 | 作用 |
| --- | --- |
| `PI_WEB_PORT` | Electron 内置服务固定端口（默认随机） |
| `PI_WEB_DIST_DIR` | Next 构建目录（默认 `.next`，打包用 `.next-pkg`） |
| `PI_WEB_UPLOADS_DIR` | 数据目录（上传 + 内部状态），优先级最高 |
| `PI_WEB_UPLOADS_MAX_BYTES` | 上传总量上限（默认 300MB） |
| `PI_WEB_CDP_PORT` | Electron CDP 调试端口（默认 9222，`0` 关闭） |
| `PI_WEB_HOSTNAME` / `PI_WEB_NO_OPEN` / `PI_WEB_SERVER_MODE` | Electron 内置服务绑定/不弹浏览器/dev 模式 |
| `PI_WEB_PASSWORD` / `PI_WEB_AUTH_USERNAME` | 可选 Basic Auth（用户名默认 `pi`） |
| `PI_WEB_ALLOWED_HOSTS` | 可信反代外部 hostname（逗号分隔） |
| `PI_WEB_UNIVER_HOME` | univer daemon 运行时根（默认 `<数据目录>/.internal/univer`） |
| `PI_WEB_BROWSER_BRIDGE_URL` | Electron 原生浏览器控制桥地址（主进程启动 bridge 时设置/写入标记） |
