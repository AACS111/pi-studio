# Pi Studio

[English](./README.md)

Pi Studio 是 [pi 编程智能体](https://github.com/badlogic/pi-mono) 的本地 Web 工作台，源自 [agegr/pi-web](https://github.com/agegr/pi-web)。它会读取本机的 pi 会话文件，在浏览器里提供会话管理、实时对话、模型配置、技能管理和项目文件预览——此外还提供了 CLI 做不到的两件事：内置**完整表格引擎**（就地查看/编辑 `.xlsx` / `.univer` 文件），以及**内置浏览器**（可被智能体驱动、推送页面）。

在保留原版 pi-web UI 全部能力的基础上，Pi Studio 新增：

- **Electron 桌面应用** — 打包的桌面壳，右侧浏览器是原生 `WebContentsView` 池，通过语义控制桥（Semantic Browser V2）驱动
- **Univer 表格深度集成** — 查看、在线编辑、git worktree 草稿、写回原 `.xlsx`、加密文件支持（WPS KET 桥）、导入压缩
- **安全加固** — Origin/Host 校验、可选 HTTP Basic Auth、路径防穿越、文件访问允许列表、上传文件名消毒
- **browser-use 侧车** — 非 Electron 环境下右侧面板自动回退到无头 Chrome
- **还有更多**：上传管理器、PWA、i18n（en/zh-CN）、Git worktrees、项目信任、skill 安装/更新/锁定、模型目录/发现/测试、视觉描述、聊天懒加载

中文微信群：请查看 [GitHub Discussions 帖子](https://github.com/AACS111/pi-studio/discussions/271)。

![CLI 与 Pi Studio 显示同一 pi 会话：结构化工具调用、可读 Markdown、会话浏览、更清爽的结果](https://raw.githubusercontent.com/AACS111/pi-studio/main/docs/screenshot2.png)

## 功能特性

### 两种运行形态

**浏览器模式** — 原版 pi-web 的 Web 体验。右侧浏览器通过服务端沙箱 iframe 代理（`/api/browser/proxy`）渲染，自动去除 `X-Frame-Options` / CSP，因此禁止 iframe 的页面也能正常显示。

**Electron 桌面模式** — 打包的桌面应用（Windows）。内置 Next 服务作为子进程运行在随机 `127.0.0.1` 端口；右侧浏览器是原生 `WebContentsView` 池（每个网页标签一个，仅一个可见），支持：

- **Semantic Browser V2 控制桥**（`electron/bridge.cjs`）：`/snapshot` 返回每个元素的 `ref/role/name/value`；评分定位器（精确文本 > aria > placeholder > testid > contains）解析元素，歧义时返回 `409` + 候选。
- **批量执行**：`/execute` 在单个 JS 上下文中完成多步动作（fill / select / click / check / wait / assert）。
- **高级动作**：原生 `<select>` 下拉 + Ant Design / Element Plus combobox，条件等待与断言。
- **CDP 远程调试**：默认 `127.0.0.1:9222`（`PI_WEB_CDP_PORT` 可改，设 `0` 关闭）。

在浏览器模式下，同一套控制 API 自动回退到 **browser-use 侧车**（FastAPI，`127.0.0.1:17865`，自动启动、失败容忍），因此智能体驱动浏览在任何形态下都可用。

### 表格编辑（基于 Univer）

- **浏览器里查看和编辑 Excel 文件**：在完整的 Univer 表格引擎中打开 `.xlsx` / `.univer` ——公式、条件格式、数据验证、筛选、排序、表格、超链接、批注、话题评论全部就地可用。
- **AI 编辑你打开的表格**：一键把上传的 `.xlsx` 转成 `.univer` 草稿，告诉智能体要改什么，右侧面板实时查看结果。
- **Worktree 安全保障**：表格草稿放在 git worktree 里——随时创建、提交、丢弃或合并回主干。未经你明确同意，绝不自动写回。
- **写回 / 导出**：把编辑提交回原 `.xlsx`（经 SheetJS 重建），或导出为 `.xlsx` / `.csv`。
- **加密工作簿**：标准 OOXML / WPS TSD / WPS 结构加密的 `.xlsx` 通过 WPS KET COM 桥解密并安全缓存。
- **导入压缩**：34 MB 的 `.univer` 导入后通常可压缩到约 10 MB。

### 会话与聊天工作台（核心）

- **随时接着干**：按项目浏览历史 pi 对话，不必翻终端历史或会话路径。
- **安全尝试不同方向**：从更早的消息继续，或把会话 fork 成独立路线。
- **跨分支工作**：在侧栏切换 Git worktree，新会话和文件资源管理器跟随所选 checkout。
- **一边聊天一边看代码**：左侧浏览文件，右侧预览源码、文档、图片、音频和 PDF。
- **会话状态一目了然**：上下文用量、成本、压缩状态、系统提示详情都在顶栏可见。
- **变更文件卡片**：每轮智能体回合结束后，汇总卡片列出所有编辑/写入的文件及 `+N`/`-M` 逐文件 diff 统计。
- **少在终端配配置**：模型、登录/API key、模型测试、插件、skill 开关都在 Web UI 里管理。
- **用你的语言**：顶栏在英文和中文（zh-CN）之间切换；通过 i18n 注册表很容易新增语言。

### 上传、视觉与文件工具

- **上传管理器**：把 `.xlsx` / `.univer` / 图片放入隔离存储区，可切换存储位置并查看容量统计。
- **视觉描述**：让智能体描述图片；视觉模型（从你的自定义提供商自动检测）生成描述。
- **文件索引**：快速项目文件搜索，快速把智能体和资源管理器指到正确的文件。
- **打开文件标记**：右侧面板当前打开的文件会暴露给智能体，所以只说「编辑这张表」就能对上号。
- **PWA**：移动端和桌面端都可把 Pi Studio 安装为离线可用的应用。

### 安全

- **Origin/Host 校验**：每个 API 请求都校验（CSRF 防护）；非 API 页面校验 Host。
- **可选 HTTP Basic Auth**：设置 `PI_WEB_PASSWORD` 即可保护 Web 界面和所有 API 端点（用户名固定 `pi`，timing-safe 哈希比较）。
- **路径防穿越** + `/api/files` 严格允许列表（会话 cwd、解析出的项目根、`~/pi-cwd-*`、显式允许的根）。
- **上传文件名消毒**、bash 输出符号链接防护、上传配额上限（默认 300 MB，按 LRU 清理）。
- **项目信任门控**：项目级 skill（`.agents/skills`）只在项目被信任后加载（`~/.pi/agent/trust.json`，与 pi CLI 共享）。

## 快速开始

Pi Studio 要求 Node.js 22.19.0 或更高版本。可通过 `node --version` 检查当前版本。

**无需安装，直接运行：**

```bash
npx @aacs111/pi-studio@latest
```

**或全局安装后使用：**

```bash
npm install -g @aacs111/pi-studio
pi-studio
```

启动后打开 [http://127.0.0.1:30141](http://127.0.0.1:30141)。命令行版本会在服务就绪后尝试自动打开浏览器。Pi Studio 默认仅监听 `127.0.0.1`。

**可选参数：**

```bash
pi-studio --port 8080              # 自定义端口
pi-studio --hostname 0.0.0.0       # 在可信网络中开放访问
pi-studio -p 8080 -H 0.0.0.0       # 组合使用
pi-studio --no-open                # 不自动打开浏览器

PORT=8080 pi-studio                # 也支持环境变量
PI_WEB_HOSTNAME=0.0.0.0 pi-studio  # 显式开放网络访问
PI_WEB_ALLOWED_HOSTS=pi-studio.internal pi-studio  # 允许指定的代理或自定义主机名
PI_WEB_PASSWORD='足够长的随机密码' pi-studio  # 启用 Basic Auth（用户名固定为 pi）
PI_WEB_NO_OPEN=1 pi-studio         # 适用于后台服务或开机自启
```

设置 `PI_WEB_PASSWORD` 可为 Web 界面和所有 API 端点启用 HTTP Basic Auth。用户名固定为 `pi`。不设置或留空即关闭认证。

Pi Studio 可以调用高权限智能体。Basic Auth 不会加密传输中的密码，请勿把纯 HTTP 暴露到公网。远程访问请通过可信反向代理的 HTTPS 或可信 VPN。
API 请求接受回环名称、IP 字面量、选定的绑定 hostname，以及 `PI_WEB_ALLOWED_HOSTS` 中以逗号分隔的精确名称。当可信反向代理使用了不同的外部 hostname 时，请配置该变量。

## 桌面应用（Electron）

Pi Studio 以 Windows 桌面应用形式发布，右侧浏览器由原生 `WebContentsView` 驱动（见[功能特性](#功能特性)）。从源码构建：

```bash
npm run pack:dir       # release/ 下的未打包目录（最快验证）
npm run pack:portable  # 单文件便携版 .exe
npm run pack:nsis      # 安装版 .exe
npm run pack:msi       # .msi
npm run pack           # 安装版 + 便携版
```

打包使用独立构建目录（`.next-pkg`），与 `npm run dev` 互不干扰。打包后的应用把内置 Next 服务跑在随机 localhost 端口，数据存放在 `%APPDATA%/Pi Studio/pi-web-uploads`（Program Files 不可写），退出时清理整棵子进程树。

## HTTP 代理

Pi Studio 读取标准 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 环境变量用于服务端模型和 API 请求。

macOS / Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @aacs111/pi-studio@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @aacs111/pi-studio@latest
```

## 说明

- **数据目录**：上传文件和内部状态存放在可配置数据目录——默认 `<项目>/pi-web-uploads/`（可用 `PI_WEB_UPLOADS_DIR`、`.pi-web-config.json` 或上传管理器 UI 覆盖）。旧数据从 `~/.pi/agent/pi-web-*` 启动时迁移一次。
- **会话文件**：Pi Studio 默认读取 `~/.pi/agent/sessions`，文件存为 `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`。设置 `PI_CODING_AGENT_DIR` 可指向其他 pi agent 目录。
- **模型配置**：模型面板读写 pi agent 目录下的 `models.json`，并与 pi 的 `AuthStorage` 提供商认证合并展示。
- **文件访问**：文件浏览和预览限定在所选项目目录与会话中出现的工作目录。
- **Git worktrees**：切换器何时出现、新 worktree 如何创建、删除会做什么，见 [Pi Studio 中的 Worktrees](./docs/worktrees.zh-CN.md)。
- **Fork vs 会话内分支**：Fork 创建新的 `.jsonl` 文件；「从这里编辑」在同一会话文件内另开分支。
- **国际化**：见 [国际化](./docs/i18n.md) 了解翻译使用与新增语言/界面文案。

## 开发

```bash
npm install
npm run dev
```

本地开发服务器运行在 [http://127.0.0.1:10141](http://127.0.0.1:10141)。

常用检查：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

开发期间不要运行 `next build` / `npm run build`——它会写 `.next/` 并干扰 dev server；构建留给发布流程。

## 项目结构

```text
app/
  api/
    agent/          # 创建/驱动 AgentSession 并暴露 SSE 事件
    auth/           # OAuth 与 API key 管理
    browser/        # 右侧网页预览标记 + 服务端代理 + 控制桥
    cwd/            # 可浏览/可校验的工作目录选择器
    default-cwd/    # pi 默认工作目录查询
    file-index/     # 项目文件搜索索引
    files/          # 文件列出、读取、预览、监听、保存
    git/            # diff 与 status 端点（变更文件卡片）
    home/           # 当前用户主目录
    models/         # 可用模型、默认模型、思考级别
    models-config/  # 读写 models.json、模型目录/发现/测试
    open-file/      # 右侧面板活动文件标记（agent 默认编辑目标）
    plugins/        # 包插件管理
    project-trust/  # 项目信任门控（.agents/skills）
    sessions/       # 会话读取、重命名、删除、上下文、HTML 导出
    skills/         # skill 列出、搜索、安装、更新检查/更新、启停
    univer/         # .univer 查看/导出/写回 + worktree 生命周期（合并/丢弃）
    uploads/        # 隔离上传存储管理
    vision/         # 视觉模型描述图片
    worktrees/      # git worktree 创建/删除
components/
  AppShell.tsx          # 主布局、URL 状态、顶部面板、文件标签
  SessionSidebar.tsx    # 项目选择、会话树、Explorer
  ChatWindow.tsx        # 消息区、SSE、拖拽图片、minimap、懒加载
  ChatInput.tsx         # 输入栏、模型/工具/thinking/compact/slash 控件
  MessageView.tsx       # 消息、thinking、工具调用/结果渲染
  ModelsConfig.tsx      # 模型和认证配置面板
  PluginsConfig.tsx     # 已安装包插件面板
  SkillsConfig.tsx      # skill 管理面板
  ProjectTrustDialog.tsx # 项目信任确认弹窗
  FileExplorer.tsx      # 文件树
  FileViewer.tsx        # 源码、diff、图片、音频、PDF、DOCX 预览
  XlsxViewer.tsx        # Univer 表格引擎（懒加载）查看 .xlsx
  UniverFileViewer.tsx  # .univer worktree 就地 diff 应用查看器
  WebViewer.tsx         # 右侧浏览器标签（WebContentsView / 侧车）
  UploadsManager.tsx    # 上传存储面板
  PwaRegistration.tsx   # Service Worker 注册
lib/
  rpc-manager.ts        # AgentSessionWrapper 生命周期与全局 registry
  session-reader.ts     # 解析 .jsonl 会话文件与分支上下文
  normalize.ts          # 规范化 toolCall 字段名
  file-access.ts        # 文件读取安全边界
  file-paths.ts         # 文件路径编码/相对路径工具
  storage-config.ts     # 上传/数据目录解析
  univer-cli.ts         # univer daemon + CLI 集成
  univer-db.ts          # 直接 SQLite 读 worktree/提交状态
  ket-bridge.ts         # 加密 .xlsx 的 WPS KET COM 解密桥
  browser-proxy.ts      # 服务端网页预览代理工具
  browser-sidecar.ts    # browser-use 侧车启动（FastAPI 回退）
  http-dispatcher.ts    # 全局 undici dispatcher（空闲超时）
  request-security.ts   # API 请求的 Origin/Host 校验
  web-auth.ts           # 可选 HTTP Basic Auth
hooks/
  useAgentSession.ts    # 会话加载、发送命令、SSE 状态机
  useAudio.ts           # 完成提示音
  useDragDrop.ts        # 图片拖拽
  useTheme.ts           # 主题切换
  useI18n.tsx           # i18n context（en / zh-CN）
electron/
  main.cjs              # 桌面主进程：next 子进程 + WebContentsView 池 + CDP
  bridge.cjs            # Semantic Browser V2 控制桥（HTTP）
  preload.cjs           # WebContentsView 页面的 preload
bin/
  pi-studio.js          # npm CLI 入口
scripts/
  package.mjs           # electron-builder 打包（.next-pkg、镜像）
  dev-electron.mjs      # dev 模式 Electron 壳
```

## License

MIT — 见 [LICENSE](./LICENSE)。基于 [pi-web](https://github.com/agegr/pi-web)（作者 [agegr](https://github.com/agegr)）二次开发，后者又构建于 [pi](https://github.com/badlogic/pi)（作者 [badlogic](https://github.com/badlogic)）。
