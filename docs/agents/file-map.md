# 文件地图

## API 路由（`app/api/`，共 60+ 个）

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
files/[...path]/route.ts         GET 文件内容（受允许根列表限制）
files/save/route.ts              POST 写回文件（base64，25MB 上限）
files/reveal/route.ts            POST 在系统文件管理器中打开文件所在文件夹（Explorer /select，spawn 分离不等待；.univer 优先定位同名 .xlsx，见 lib/univer-paths.ts）
files/open-external/route.ts     POST 用系统默认程序打开文件（cmd start / open / xdg-open；.univer 优先打开同名 .xlsx）
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
browser/control/[...path]/route.ts 流式透传到浏览器控制桥（Electron 原生 WebContentsView；npm run dev 纯浏览器模式无桥，返回 502）：
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

## `lib/`

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

## `components/`

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
ChangedFilesCard.tsx   助手消息下的统一文件卡（变更+生成都在这张卡：M/A 徽标 + 扩展名标签 + diff 统计；每行支持右侧打开 / 打开所在文件夹 / 外部打开；.univer 的外部动作解析为同名 .xlsx）
PwaRegistration.tsx    Service Worker 注册
MobilePwaLayout.tsx    移动 PWA 布局
FileIcons.tsx          文件图标
```

## `hooks/`

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

## Electron（`electron/`）

```
main.cjs    桌面主进程：ELECTRON_RUN_AS_NODE=1 起 next start（随机端口）；WebContentsView 标签池；
            CDP 远程调试（9222）；下载目录；退出杀整棵子进程树
bridge.cjs  Semantic Browser V2 控制桥（HTTP，127.0.0.1 随机端口）：/snapshot /execute /open
            /select /fill /wait /assert 等语义接口，基于 executeJavaScript 注入评分定位器
preload.cjs WebContentsView 的 preload（网页侧桥接）
```

## 其他

```
bin/pi-studio.js        CLI 入口（node 版本门禁 + next 启动 + 端口/host/自动开浏览器）
scripts/package.mjs     打包（.next-pkg + electron-builder + 国内镜像）
scripts/dev-electron.mjs dev 模式 Electron
.agents/skills/          项目技能：browser-control / sheet-edit / univer-cli / univer-integrate / web-preview
docs/                    i18n.md / release.md / worktrees.md(.zh-CN.md)
proxy.ts                 Next middleware：API 的 Origin+Host 校验
instrumentation.ts       启动钩子：数据目录迁移 + undici dispatcher + univer daemon 暖机
```
