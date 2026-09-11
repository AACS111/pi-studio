# 关键设计决策与坑

## 右侧面板 open-file 标记（agent 约定）
- `AppShell` 在激活文件 tab 变化时上报 `/api/open-file`（按路径去重，只变更时发）。路由把 `{ filePath, updatedAt }` 持久化到 pi-studio 数据目录（默认 `<项目>/pi-web-uploads/.internal/pi-web-open-file.json`，位置可配置，见 `lib/storage-config.ts`），原子 tmp+rename 写。
- **约定：用户说「编辑这张表」又没点名文件时，默认编辑该标记记录的文件**（右侧查看器里打开的那个）。用 `GET /api/open-file` 或直接读标记文件；缺失/未设置就问用户。
- **上传存储**：上传文件、AI 编辑 .univer 产物、pi-studio 内部状态都在可配置数据目录（默认 `<项目>/pi-web-uploads/`，`.internal/` 存放 open-file 标记、user-edits 侧车、univer CLI home）。解析顺序：`PI_WEB_UPLOADS_DIR` env → `.pi-web-config.json` 的 `uploadsDir`（可在 UI 改）→ 项目默认。旧数据从 `~/.pi/agent/pi-web-*` 启动时迁移一次（`instrumentation.ts` → `migrateLegacyData()`）。

## Changed-files 卡片（每轮变更摘要）
- `extractChangedFiles()`（`lib/changed-files.ts`）扫描助手 turn 的 toolCall 块里的 `edit`/`write` 工具（input 字段是 `path` 不是 `filePath`），去重返回 `{filePath, kind}`。
- **非项目文件不显示（2026-08-12）**：提取函数接受 `cwd` 参数，绝对路径在会话 cwd 之外（Temp 脚本、其他目录产物）一律过滤；相对路径视为项目内。~~`extractGeneratedFiles()` 另拆生成文件卡~~（2026-08-27 已合并：生成文件与变更共用同一张 `ChangedFilesCard` 统一展示，避免两张卡重复列出同一批文件；原 `extractGeneratedFiles`/`GeneratedFilesCard` 已删除）。
- **生成文件自动推右侧（2026-08-12）**：agent 生成表格后 `POST /api/open-file-request`（`{filePath,title?}`），AppShell 每 3s 轮询该标记并自动开文件 tab（作用一次后 DELETE），与 /api/browser 的网页预览同一模式。
- 卡片由 `ChatWindow` 渲染，**不在 MessageView 内**：assistant turn 被拆成折叠的 `ProcessDetailsGroup`（思考+工具调用）和独立最终回答消息。卡片必须放在**消息 footer 层**（回答文本下方、用量统计上方），否则会被折叠进 process group。
- 变更文件从**组内所有 assistant 消息**（`userIdx+1..endIdx`）收集，不只看最终回答。
- 每个文件的 `+N`/`-M` diff 统计从 `/api/git/diff` 惰性拉取并用 `parseUnifiedPatch` 解析。fetch effect 依赖**稳定的 `filesKey` 字符串**，绝不依赖 `files` 数组引用（父组件每次渲染重建数组 — 依赖它会导致 fetch 风暴打崩 dev server）。
- 流式尾部（`isLiveTail` + `streamingMessage`）也渲染卡片，让编辑实时可见。

## AgentSession 生命周期（`lib/rpc-manager.ts`）
- 每个 session id 一个 `AgentSessionWrapper`，挂在 `globalThis.__piSessions`（Next.js 热重载下 module 级 Map 会丢，globalThis 不会）。
- 空闲超时 10 分钟。并发的 `startRpcSession()` 共享单个启动 Promise（`globalThis.__piStartLocks`）。

## Fork 必须立刻销毁 wrapper
`AgentSession.fork()` **原地修改 wrapper 内部状态** — fork 之后 `inner.sessionId` 变成新会话的 id。如果 wrapper 还以旧 id 活在 registry 里，下一次请求会拿到已 fork 的状态，后续 fork 产生损坏的 `parentSession` 链。
**修复**：`send("fork")` 拿到 `newSessionId` 后先 `this.destroy()` 再返回。下次请求原会话时从原文件重新加载干净的 AgentSession。

## 两种分支，别混淆
- **Fork**（用户消息上的 Fork 按钮）：创建独立的新 `.jsonl` 文件，经 `parentSession` 头字段在侧栏树里显示为子节点。
- **会话内分支**（Continue 按钮 / BranchNavigator）：同一文件内 `navigate_tree`，多个条目共享同一个 `parentId`，切换走 `/api/sessions/[id]/context?leafId=`。

## 会话文件可整文件重写
`parentSession` 头字段**只是显示元数据** — 对聊天内容零影响，可安全 `writeFileSync` 整个文件（pi 自己迁移时也这么干）。删除会话时级联重挂子会话就靠它。

## ToolCall 字段归一化
pi 把 toolCall 块存成 `{type:"toolCall", id, name, arguments}`，而 `ToolCallContent` 用 `{toolCallId, toolName, input}`。`normalizeToolCalls()`（`lib/normalize.ts`）处理这个映射 — `session-reader.ts`（文件加载）和 `ChatWindow.handleAgentEvent()`（流式）都调用。

## 新会话工具预设
建会话时传 `toolNames[]`（`POST /api/agent/new`）。已有会话挂载时经 `get_tools` → `getPresetFromTools()` 推断预设。工具全禁用（`toolNames = []`）时，`rpc-manager.ts` 传空 allow-list 并强制 `agent.state.systemPrompt = ""`（启动/重载/资源发现之后都要设）。

## 新会话模型默认值
`GET /api/models` 从 `~/.pi/agent/settings.json` 读 `defaultModel`，`ChatWindow` 挂载时预选。显式的模型/思考级别选择在 AgentSession 构造时原子应用，随后 `lib/startup-preferences.ts` 持久化生效值**而不重放** `set_model`/`set_thinking_level`；隐式的 `enabledModels` 回退与思考固定不持久化。

## `enabledModels` 作用域
`enabledModels` 用 pi 的 `--models` 语法：minimatch glob 匹配 `provider/modelId` 或裸 `modelId`，非 glob 模式模糊匹配，可带 `:thinkingLevel` 后缀。**永远别把这些模式当字面字符串比较** — `lib/model-scope.ts` 委托 SDK 的 `resolveModelScopeWithDiagnostics()`，让 pi-studio 和 TUI 看到一致的模型列表；模式解析为空时回退全部模型。`startRpcSession()` 在创建 AgentSession 前解析作用域，原子传入初始模型、思考固定和 SDK 原生 `scopedModels`；`GET /api/models` 只用同一 helper 取选择器数据、`thinkingLevelPins` 和 `modelScopeWarnings`。

## 页面刷新中断流后 SSE 重连
`ChatWindow` 挂载时先 `GET /api/agent/[id]`；若 `state.isStreaming === true` 自动重连 SSE，并同步 `thinkingLevel` / `isCompacting`。

## Compaction SSE 事件
新 pi 发 `compaction_start`/`compaction_end`，旧版发 `auto_compaction_start`/`auto_compaction_end`。`handleAgentEvent` 两套都收，保证 `isCompacting` 同步。手动 compact 是阻塞 POST — 按钮在响应返回前保持禁用。

## 上下文瘦身（pi-ai 补丁 + 25% 自动压缩）

**问题（实测 2026-09-11，d2o 会话 `2026-09-11T08-54-52…01a08fad`）**：一个 80 行数据的前端卡顿 bug 烧掉 **34,129,859 token / 283 次调用**（其中 99.2% 是 cacheRead），全程 27 分钟。请求体构成：历史 thinking **350KB（48%）** + 工具结果 **265KB（37%）**。根因不是 bug 难：LLM 无状态，第 n 轮要重发前 n−1 轮，总开销对轮数是平方级；而 deepseek-flash 声明窗口 1,000,000 + `reserveTokens: 19661` ⇒ 要涨到 ~98 万才触发压缩，240k 的上下文永远压不掉。

**① 补丁：`patches/@earendil-works__pi-ai.patch`**（`pnpm patch @earendil-works/pi-ai` 生成，升级该包后需重打）
改 `dist/api/openai-completions.js` 的 `convertMessages`，新增 `planContextDiet()`：
1. **历史 thinking 只保留最近一条 assistant**（更早的 `reasoning_content` 置空）。注意 thinking 只在 `transformMessages` 判定「同 provider + api + model」时才回传，跨模型本来就丢。
2. **陈旧工具结果折叠**：保留最近 8 条（`PI_KEEP_RECENT_TOOL_RESULTS`），更早且 >2000 字符的换成一行 `[folded: bash output was N KB / M lines …]`（`PI_FOLD_TOOL_RESULT_MIN_CHARS`）；被折叠的图片型结果不再附图。

开关 `PI_CONTEXT_DIET=0` 关闭。**只改发给模型的内容**，会话文件 / UI / 审计不受影响。
- **实测**（同一份 d2o 会话 573 条消息跑 `convertMessages`）：请求体 **974,606 → 454,737 字符（−53.3%）**，折叠 40 条工具结果。
- **前置验证**：DeepSeek `/chat/completions` 在 `thinking:{type:"enabled"}` 下，历史 assistant 消息不带 `reasoning_content`（含 tool_calls + tool 结果链路）均返回 200 ⇒ 置空安全。

**② 自动压缩改为按窗口比例触发（默认 25%）**
- `lib/compaction-settings.ts`：新增 `triggerRatio`，写进 settings.json 的 `compaction` 段（pi 用 `settings.compaction?.reserveTokens ?? …` 普通属性读取，不校验多余字段）。`recommendedCompactionForWindow(window, ratio)` ⇒ 触发点 `window×ratio`、`reserveTokens = window − 触发点`、`keepRecentTokens = min(窗口 15%, 触发点 25%)`（且 ≤ 触发点 50%）。
- `lib/rpc-manager.ts`：**每次会话启动按当前模型窗口重算**阈值（值没变不写盘）。于是同一份配置对 1M 窗口 = 250k 触发 / 62.5k 保留，对 131k 窗口 = 33k 触发 / 8.2k 保留。
- `app/api/settings/compaction`（GET/PATCH）+ `SettingsPanel` 会话分组里的「上下文自动压缩」行（点行或右侧 pill 在 25/40/60/85% 循环）。PATCH 会用 settings.json 默认模型的窗口立即折算阈值，避免「比例改了、reserveTokens 还是旧值」。
- 兜底：用户手调过的 `reserveTokens` 也会被这套策略接管；想回到旧的 85% 行为，把比例调到 85%。

**没做（评估过并放弃）**：改 `contextWindow`（会污染模型目录显示）、全局 reserveTokens（对多模型窗口不通用）、每次压缩都重写会话文件（破坏审计）。

## 运行状态轮询 + 对账
- 侧栏每 2.5s 轮询 `/api/agent/running`（标签页可见时；后台标签暂停，会话列表响应作初始回退）。
- `useAgentSession` 把每条会话的 SSE 当主通道，每次 prompt 前打开。`prompt_done` 完成当前 UI 阶段与通知，但空闲 SSE 保持 30s 宽限窗口供下次 prompt 复用。`agent_start` 取消关闭定时器；`agent_settled` 收尾扩展注入的、没有 wrapper 级 `prompt_done` 的运行并开新宽限窗。**别在第一个 `agent_end` 就关闭**：重试、compaction、扩展排队消息会延续同一逻辑 prompt。
- 运行期间周期调 `GET /api/agent/[id]` 并在 `visibilitychange`/`online` 时对账，修复后台标签/半开连接的漏事件。
- Prompt 运行用单调 run id；旧 run 的迟到 SSE 或慢对账响应必须忽略，防止复活过期流式气泡。

## Worktrees 与项目分组
- `lib/worktree.ts` 把链接的 worktree 顶层解析回主仓库 `projectRoot`；`listAllSessions()` 把它挂到每个 `SessionInfo`，同一仓库的所有 worktree 在侧栏里归组。
- worktree 操作由 `/api/worktrees` 服务，受 `/api/files` 相同的允许根规则保护。
- 新 worktree 建在 `<repoRoot>-worktrees/<sanitized-branch>`；已有分支复用，否则 `git worktree add -b`。
- 删除脏 worktree 返回 `409 { dirty: true }`，UI 询问后 `force` 重试。
- cwd 指向已删 worktree 的会话回退归到主项目，不产生幽灵项目行。

## Univer 查看器就地同步（`.univer` 文件）
- **每个文件一个 Univer 实例**。`XlsxViewer` 在 scope 切换间保活；scope 变化（分支切换 / 外部 `univer execute` 提交）**就地 diff 应用**（单元格 v/t/f/s 走 `FRange.setValue`，合并走 `merge()` / `sheet.command.remove-worksheet-merge`），不是销毁重建。只有结构性变化（sheet 集合/名称/尺寸、CF/校验/筛选资源、或 >8000 个变更单元格）才回退重建。
- **解析 scope 缓存**（`loadScopeData`/`warmScopeData`）：每个 scope 的解析工作簿按 `scopeKey = <file>::wt:<id>::<headCommit>`（或 `::trunk::<mtime>`）缓存。`UniverFileViewer` 的轮询只在**正在看的** scope 内容外部变化时才推进 `ackRevRef` — 其他 worktree 的提交、状态变化、用户自己的自动保存（`ownSaveRef`：worktree=headCommit seq，trunk=文件 mtime）永不重同步网格。
- `/api/univer/worktrees` 返回 `trunkRev`（文件 mtime）供前端缓存 key；合并会使其失效（无论看的是什么）。
- **Agent 铁律：永不自动合并 worktree。** 在 worktree 上编辑 → `worktree ready` → 停下，用户自己在查看器里点「合并到主干」或明确要求。**该铁律对所有 skill 一律适用**：任何 skill 模板/流水线不得写死 `univer worktree merge`，编辑完只标记 ready 即停手。
- **验证纪律**：每个改动必须过 tsc + eslint + headless 浏览器往返（trunk→worktree→trunk 带样式断言）再交付 — 绝不把未验证状态交给用户（浏览器可能跑着旧 chunk/scope 缓存）。坑位清单见 sheet-edit 技能的交付流程铁律/常见坑（`setValue` 合并语义、`s:null` 是唯一清样式方式、SheetJS 丢对齐、`getCellData().s` 是样式 id 要读 `wb.save().styles[id]`、daemon 文件锁、dev 端口 10141）。

## 办公文档两段式打开（.doc/.docx/.ppt/.pptx）

与表格体验一致的两段式：**默认原生预览，点「AI 编辑」才进工作流**。

- **默认直接预览**：doc/docx 走 mammoth HTML 预览（`DocumentViewer`）；ppt/pptx 走隐藏缓存只读预览 —— `POST /api/univer/ppt-preview` 把转换副本落到 `.internal/univer-view-cache/`（不进任何文件列表）+ 网关 iframe。
- **只有点「AI 编辑」**才经 `POST /api/univer/from-xlsx` 生成可见的 `<basename>-ai-edit.univer`，进 worktree 工作流。
- **agent 约定**：对话里被要求「创建/编辑 PPT、文档」时，一律用 office-edit skill 操作 `.univer` 文件并 `open-file-request` 推右侧；需要交付原件再 export 回 `.docx`/`.pptx`。
- **#坑**：`UniverFileViewer` 对纯 doc/slide 单元**绝不能**走 `/api/univer/view` 的 xlsx 导出（CLI 报 `cannot export doc unit as xlsx`），已按 units 是否含 sheet 门控。

## 加密 xlsx（KET 桥）
标准 OOXML 加密 / WPS TSD 加密 / WPS 结构加密的 `.xlsx` 无法被 fflate/SheetJS 解析时走 `lib/ket-bridge.ts` 的 WPS KET COM 自动化（ProgID `Ket.Application`）：首选 `Workbooks.Open` → `SaveAs(FileFormat=51)` 另存为标准 xlsx 并校验 PK 魔数；受限 WPS 365 企业版强制 TSD 容器时兜底 COM 按 Range 取数 + SheetJS 重建（只还原活动工作表）。解密结果按「源路径|大小|mtime|密码」缓存（上限 32 个 / 7 天）。KET 调用 90s 超时防弹窗挂死。

## 文件访问允许列表
- `/api/files` 刻意不是通用文件系统浏览器。允许根来自：会话 cwds、其解析出的项目根、`~/pi-cwd-*`、以及显式 `allowFileRoot()` 添加的根。
- `/api/cwd/validate`、`/api/default-cwd`、`/api/worktrees` 在产生新可浏览位置时调用 `allowFileRoot()`。
- `/api/files/save`、`/api/git/*`、`/api/file-index` 走同一套 `isFilePathAllowed` 校验。

## Plugins 和 skills
- `/api/plugins` 用 pi 的 `SettingsManager` + `DefaultPackageManager` 做全局/项目包安装、移除、更新、启停。禁用时把该包条目的 `extensions/skills/prompts/themes` 数组写成空。
- `/api/skills` 用 `DefaultResourceLoader`，settings 路径、包 skills、项目 `.agents/skills` 与运行时视角一致。
- **项目技能在 `.agents/skills/`**（browser-control / sheet-edit / univer-cli / univer-integrate / web-preview），随仓库分发。只在项目被信任（`~/.pi/agent/trust.json`，与 pi CLI 共享；`/api/project-trust` 记录，busy 时拒绝并事后销毁 cwd 会话）后加载。新增 `.agents/skills` 的项目会翻转 `hasTrustRequiringProjectResources` — 未信任项目完全跳过（`projectResourcesLoaded: false`）。
- skill 开关只改目标 `SKILL.md` 的 `disable-model-invocation` frontmatter 键，保持外科手术式修改以保留用户格式。
- `/api/skills/install` 走 `npx skills add ... --agent pi`；项目级安装用所选 cwd。`/api/skills/check` 与 `/api/skills/update` 用 git 浅克隆到系统 tmpdir 做版本比对。

## Auth 和模型配置
- `ModelsConfig` 把 `~/.pi/agent/models.json` 的模型与 pi `AuthStorage`/`ModelRegistry` 的提供商认证状态合并展示。
- 提供商列表是**能力驱动，绝不 id 驱动**：`lib/provider-listing.ts` 依据 `auth.apiKey.login` / `auth.oauth` 加已存凭据类型决定归属，双认证提供商（现在 anthropic 与 github-copilot — SDK 版本之间声明会变，别按 id 猜）恰好出现一次、绝不双列。
- auth.json 每个提供商**一个**凭据，`ModelRuntime.logout()` 删掉它。删除路由因此用 `removeStoredCredentialIfType()` 在 pi auth 存储同一文件锁下比较再删。`ModelsConfig` 在任何认证变化后**刷新两个列表** — 只刷一个会让双认证提供商渲染两次。
- OAuth/device-code/manual-code 流由 `GET /api/auth/login/[provider]` SSE 流式输出；manual code 响应 POST 回短时 token 存 `globalThis.__piLoginCallbacks`。
- API-key 路由经 `AuthStorage` 存/删，状态端点绝不返回裸 key。
- 模型测试路由是 `app/api/models-config/test/route.ts`；`app/api/models/test/` 不是真实路由。

## 完成音
- `hooks/useAudio.ts` 把开关存 `localStorage` 的 `pi-sound-enabled`，复用一个 `AudioContext`。
- 浏览器自动播放策略要求从用户手势解锁；`ChatInput` 在交互控件上调用解锁 hook，`ChatWindow` 从 `onAgentEnd` 播放提示音。

## 导出的会话 HTML
`/api/sessions/[id]/export` 委托 pi 导出助手，再把生成 HTML 里的递归树 helper 补丁成迭代版本，避免极深线性会话把浏览器调用栈打爆。

## Electron 桌面壳
- `main.cjs` 用 `ELECTRON_RUN_AS_NODE=1` 让 exe 扮演 node 启动 `next start`（随机端口 / `PI_WEB_PORT` 固定；dev 模式 `PI_WEB_SERVER_MODE=dev` 走 10141）。子进程（含 univer daemon）继承该 env。
- 打包后数据目录移到 `%APPDATA%/Pi Studio/pi-web-uploads`（Program Files 不可写）。
- **dev 模式必须用独立 userData**：两者都 `app.setName("Pi Studio")`，userData 按 app 名惰性解析；若不重定向，dev 版会落到与 exe 版相同的 `%APPDATA%/Pi Studio`，导致单实例锁冲突（exe 在跑时 `dev:electron` 的 `requestSingleInstanceLock()` 返回 false → `app.quit()` 假死，窗口永远不出现）且数据目录互相污染。修复：`SERVER_MODE==="dev"` 时 `app.setPath("userData", ...)` 重定向到 `%APPDATA%/Pi Studio Dev`，**顺序必须是先 setName 再 setPath**（首次访问 `getPath` 会缓存路径，setName 会改写它）。
- 右侧浏览器 = WebContentsView 池，每网页标签一个，仅一个可见；`bridge.cjs` 起 HTTP 桥暴露语义控制接口；CDP 端口 9222（`PI_WEB_CDP_PORT` 改/关，dev 脚本默认 9223 避开 exe）。
- **绝不在 `did-start-loading` 销毁浏览器视图**：曾为清理「主窗口 reload 后残留的幽灵视图」而在该事件无差别销毁全部 WebContentsView，但 dev（Turbopack）下**切会话 / 会话数据加载 / RSC 导航 / 子 frame 加载都会触发 `did-start-loading`**，会把用户正在看的页面杀掉（现象：切会话回来后先正常渲染、会话数据重载完就空白，手动切标签反而能恢复）。正解：只在 `did-start-navigation` 判定为**主帧跳文档导航**（真正的整页硬重载，新旧 Electron 签名兼容见 `parseNavDetails`）时把现有视图标记为孤儿，`ORPHAN_GRACE_MS`（5s）宽限期内被 `create`/`setVisible`/`setBounds`/`navigate` 任一 IPC 认领（`claimWebView`）即清除标记，超时无人认领才销毁；软导航完全不碰视图。
- **渲染层另有一道自愈**：`components/WebViewer.tsx` 在 `active` / `visibilityTick`（面板收起→可见）/ `sessionEpoch`（会话 key 变化）任一信号变化时跑 `runHeal()`：幂等 `create(tabId)` + `getInfo(tabId)`，若视图 URL 为空白（`about:blank`/空/`chrome://`/`edge://`）则用 `lastUrlRef` 重导航。注意 `visibilityTick` **不能进 bounds-sync effect 的 deps**（会形成 bump→重跑→再 bump 死循环）。
- **切会话 / 切项目都要保住 web 标签**：`AppShell.handleSelectSession` 与 `handleCwdChange` 从 panelMemory 恢复右侧标签时必须把 `currentWebTabs` **合并**进去，不能整体 `setFileTabs(savedPanel.fileTabs)` 覆盖，否则右侧网页标签会被丢。新建的 `<WebViewer>` 统一传 `sessionEpoch={sessionKey}`。
- 退出时按 pid 树杀服务子进程；下载目录统一收进 `browserDownloadsDir`。
- **打包**（`scripts/package.mjs`）：自动设 `PI_WEB_DIST_DIR=.next-pkg` 与国内镜像（electron-builder-binaries / electron），GitHub 不可达时不卡下载；`electron-builder.yml` 用 `asar: false`（内置服务要读真实文件路径）、`npmRebuild: false`（原生依赖均为预编译产物）。命令：`pack:dir` / `pack:portable` / `pack:nsis` / `pack:msi` / `pack`。

## 浏览器控制桥（Semantic Browser V2）
- **仅 Electron 模式**：右侧浏览器由 Electron 内嵌 WebContentsView 渲染，`bridge.cjs` 用 `executeJavaScript` + CDP 落到同一页面，语义接口（/snapshot /execute /select /fill /check /wait /assert）只在此模式提供。snapshot 返回 ref/role/name/value；评分定位器顺序 精确文本 > aria > placeholder > testid > contains，歧义返回 409 + 候选。
- **npm run dev 纯浏览器模式不支持右侧浏览器**：无桥时 `/api/browser/control/*` 返回 502（提示改用 dev:electron / 打包应用），面板显示「仅 Electron 支持」。
- `/api/browser/control/[...path]` 把请求流式透传到桥，agent 通过它观察并操作右侧页面。桥地址从 `PI_WEB_BROWSER_BRIDGE_URL` env 或数据目录 `pi-web-browser-bridge.json` 标记读取（Electron 主进程启动 bridge 时写入）。

## 安全模型（proxy.ts）
- `/api/*` 请求校验 Origin（同源或可信列表）+ Host；非 API 页面只校验 Host。
- `PI_WEB_PASSWORD` 开启 Basic Auth（用户名固定 `pi`，sha256 + timingSafeEqual）；`PI_WEB_ALLOWED_HOSTS` 允许可信反代的外部 hostname。
- 上传文件名消毒（`sanitizeUploadName` 防穿越）；`/api/files/save` 走允许根校验。

## bash 输出临时文件
- 大命令输出由 pi 写到系统 tmpdir 的 `pi-bash-*.log`，`/api/agent/[id]/bash-output` 提供读取（内联显示限 5MB，下载走流式）。路径必须位于 tmpdir 根且文件名匹配白名单（`lib/bash-output.ts`），`O_NOFOLLOW` 打开防符号链接，且必须被该会话真实引用（`lib/session-file-references.ts` 扫会话条目）。
- 这些文件在系统 Temp 里不随会话结束自动清理，属已知行为；定期清空 `%TEMP%` 下 `pi-bash-*`、`univer-view-*`、`pi-web-*`、`pi-cdp-*`、`piweb-cdp-*` 前缀文件即可（详见「Temp 目录卫生」）。

## 性能与稳定性
- **undici dispatcher**（`lib/http-dispatcher.ts`）：`instrumentation.ts` 启动时调 `configureHttpDispatcher()`，全局 fetch 走带 300s 空闲超时（`DEFAULT_HTTP_IDLE_TIMEOUT_MS`）的 Client，并吞掉终止响应体时的内部 Client error（否则 EventEmitter error 直接打死 Next 进程）。超时是 `configureHttpDispatcher(timeoutMs)` 的代码级参数（`0` 禁用），非环境变量。
- **聊天懒加载**（`lib/chat-lazy-load.ts`）：默认只渲染末尾 50 条，滚到底加载上一页 50 条，保持滚动距离不跳。
- **univer 读取**：`/api/univer/view` 有 30min TTL 导出缓存 + 同 key inflight 合并 + edit-commit 后预热；尺寸/提交信息直接 SQLite 读，不跑慢 CLI。

## Temp 目录卫生
pi-studio 相关临时产物都落在系统 Temp（`%TEMP%` / `os.tmpdir()`），按前缀可分：
- `pi-bash-*.log` — 大命令输出缓存
- `univer-view-*.xlsx` — univer 导出缓存文件
- `pi-web-model-discovery-*` / `pi-web-skill-check-*` — 模型发现与 skill 更新检查的临时目录
- `pi-cdp-*` / `piweb-cdp-*` — pi/pi-studio 的 Chrome CDP user-data 目录（每个约 20-40MB，用后残留）
- `cdp-test-profile` / `piweb-cdp-smoke-*` / `e2e-profile` 等 — 测试/验证临时 profile

全部可在 pi-studio 未运行时安全删除。若想自动清理：在 dev 启动脚本（`restart-dev.ps1` 或 dev 前置命令）里加一步删除这些前缀的旧文件即可；不要删正在运行的会话可能仍要读的 `pi-bash-*`（仅删除超过若干小时的）。

## 多 Agent 项目组：角色边界与产物可读性（run bcfc16cd 复盘修复）

一次真实 run（bcfc16cd，40 分钟被手动停止）暴露 7 项机制缺陷，2026-08-27 全部修复（回归测试 `lib/team/role-boundary.test.mjs`）：

- **写权限策略**（`AgentDef.writePolicy: "all"|"docs"|"none"`，缺省推导 = toolNames 含 edit → all 否则 docs）：leader/product/tester 等 docs 角色在工具层剔除内置 edit/write、注入仅限 .md 且必须在 cwd 内的受控写工具（`createDocWriteTool`），防越权改业务代码。已知局限：bash heredoc 写文件挡不住。
- **群聊消息恒非空兜底 + 假宣称检测**（`buildFallbackGroupMessage` / `detectPhantomClaims`）：无文本/无交接/无变更也产出可见结论；宣称「重写 X.java」但 X 不在实际变更集 → 群聊追加 ⚠️ 宣称核对行；截断执行诚实标注「回合上限截断」而非「完成」。
- **verdict 同向多边消歧**：多条件路由的 verdictGuard 边用 record_decision content 的【最早关键词命中位置】选边（否定从句里的反向词如「与后端无关」会晚于真正归属词出现），无命中回退最高 priority。runtime 对「有 verdict 却走了 keyword 路由」发系统警示提示补配 guard 边。
- **产物指针换向**：`runs/<runId>/thinking/<agentId>.md` 富化为 结论+交接+真实变更清单+工具轨迹+思考流水（~9KB 截断），下游角色的前序上下文指向它而非不可读的 session jsonl（jsonl 仅供引擎 resume/stats/审计）。summaries 注入上限 500→1600 字。
- **收尾要求强制注入**：每次执行的上下文块必含「record_decision verdict / 交接只许陈述真实发生的事 / 交接写全接续所需信息」，修 0 决策全靠关键词路由的老毛病（根治仍有待 P1-4 LLM judge）。

## 多 Agent 项目组 v2：DAG 编排引擎（plan-then-dispatch）

2026-08-27 第二次重构（起因：run bcfc16cd 40min 空转、关键词误派、交付物丢失，"还不如单 agent"）。核心思想换血：**不做角色自由路由，做任务计划调度**（借鉴 CrewAI hierarchical / LangGraph supervisor / MetaGPT SOP）：

- **引擎选择**：`TeamDef.orchestration: "dag"|"transitions"`。新建团队由 `lifecycle.createTeam` 注入 `"dag"`；存量团队未设置 → 继续 transitions 引擎；PATCH `/api/teams/:id {orchestration}` 可切换。
- **Phase A 计划**：入口角色作 planner，用 `team_submit_plan` 受控工具一次性提交任务 DAG（工具层校验：agentId 存在 / 依赖引用存在 / Kahn 无环 / ≤12 任务）；校验失败最多纠错 2 轮，仍失败**自动回退 transitions 引擎跑完本 run**（系统消息告知，永不断粮）。
- **Phase B 调度**（`runtime.ts pumpDag`）：按 dependsOn 就绪集波次派发，无依赖任务真并行；verdict=fail/失败 → 同任务重试并附失败反馈（上限 maxReworkRounds），不扩散到无关角色；重试耗尽 → 下游依赖级联跳过防死锁。每任务执行上下文 = `buildTaskContext()`（任务+验收标准+上游 deliverable 结构化注入），不再灌前序摘要/文件指针/全量聊天。
- **Phase C 收尾**：全部完成或部分阻塞 → 入口角色出最终报告（❌ 任务如实标注），终态 completed（不再有 max_rework 硬失败路径）。
- **公共执行体**：launchAgent/pumpDag 共用 `spawnExecution()`（execution 事件流/统计/取消透传）；plan 经 executor 的 `result.plan` 透出（tools.test 覆盖工具校验，dag-scheduler.test.mjs 覆盖调度循环）。
- planner 轮及全部 DAG 系统消息（📋 计划路线图 / ✅ / 🔁 / ❌ / 回退说明）在群聊可见——用户实时看到「谁在干什么、为什么」，替代黑盒等待。

### 与旧 transitions 引擎的关系
- resolveRoute/handoff/gateway/rework 边全套保留且为默认编排（存量团队零行为变化）；
- DAG 引擎不读 transitions/reworkEdges；no-progress ping-pong 守卫、hybrid 关键词兜底等补丁在 dag 模式下天然不需要（就绪集有限 × 重试上限 = 必然终止）；
- verdictGuard 消歧（decisionContent 最早命中位置）、群聊兜底消息、假宣称检测、写权限策略两条腿共用。
