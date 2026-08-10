---
name: browser-control
description: "控制右侧浏览器（Electron 原生 WebContentsView 或 browser-use 侧车）并诊断页面内容：打开/跳转页面、点击、输入、按键、滚动、前进后退、刷新、截图、提取页面文本。agent 通过 curl 调用本地浏览器控制桥（127.0.0.1，端口见下方发现逻辑）。Use when the user wants you to interact with a live website (fill a form, click through, check dynamic content), take a screenshot of a page, or extract readable page text."
---

# 控制浏览器（browser-control）

右侧面板有两种驱动模式，接口一致：

| | Electron 桌面壳（默认） | npm run dev / 浏览器模式 |
|---|---|---|
| 渲染 | 原生 WebContentsView，无截图帧流 | browser-use headless Chrome 实时镜像 |
| 控制 | Electron 主进程控制桥（CDP/executeJavaScript） | browser-use 侧车（127.0.0.1:17865） |
| 体验 | 流畅、页面与 agent 同会话 | 有像素流延迟，可接受但不如原生 |

## 发现控制桥地址

先按顺序取 `baseUrl`：

1. 环境变量 `PI_BROWSER_USE_BASE_URL`（Electron 主进程已设置）；
2. 桥标记文件 `pi-web-uploads/.internal/pi-web-browser-bridge.json` 的 `baseUrl`；
3. 回退 `http://127.0.0.1:17865`（browser-use 侧车）。

PowerShell 示例：

```powershell
$dataDir = if ($env:PI_WEB_UPLOADS_DIR) { $env:PI_WEB_UPLOADS_DIR }
  elseif (Test-Path "pi-web-uploads") { (Resolve-Path "pi-web-uploads").Path }
  else { Join-Path $env:APPDATA "Pi Studio\pi-web-uploads" }
$marker = Join-Path $dataDir ".internal\pi-web-browser-bridge.json"
$base = if ($env:PI_BROWSER_USE_BASE_URL) { $env:PI_BROWSER_USE_BASE_URL }
  elseif (Test-Path $marker) { (Get-Content $marker -Raw | ConvertFrom-Json).baseUrl }
  else { "http://127.0.0.1:17865" }
```

## 启动（仅 browser-use 模式需要）

```bash
tools/browser-use-server/start.bat
```

- 端口 **17865**（`PI_BROWSER_USE_PORT` 可改），日志 `tools/browser-use-server/server.log`。
- 首次请求会自动启动 headless Chrome（系统 Chrome，独立 profile，不碰用户浏览器）。
- 侧车未启动时先启动；启动脚本会检测端口已存在则跳过。

## API（全部 JSON；`baseUrl` 见上方发现逻辑）

### 导航
```bash
curl -s -X POST http://127.0.0.1:17865/open -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'   # 打开/跳转
curl -s -X POST http://127.0.0.1:17865/back            # 后退（返回 {moved:true/false}）
curl -s -X POST http://127.0.0.1:17865/forward         # 前进
curl -s -X POST http://127.0.0.1:17865/reload          # 刷新
curl -s http://127.0.0.1:17865/url                     # 当前 {url,title}
```

### 面板实时镜像（右侧面板「Agent 控制台」自动使用）

面板**不再消费侧车的 SSE 推流**：右侧面板从 `GET /cdp` 拿到当前页面 target 的 DevTools
WebSocket 地址后**直连 Chrome**（启动参数带 `--remote-allow-origins=*`），用 DevTools 同款
`Page.startScreencast` 收变化帧（页面静止时零开销，交互时秒级跟手）——帧从 Chrome 直接推到
面板，不再经过 Python 转发，交互延迟和帧率都远好于旧版 SSE 轮询截图。输入仍走侧车 `/input`
（侧车负责 popup 跟随、session 重绑、自愈）。

```bash
curl -s http://127.0.0.1:17865/cdp          # 当前镜像页面的 CDP WS 地址 {port,targetId,wsUrl}
# 面板 = GET /api/browser/control/cdp → 直连 wsUrl → Page.enable + Emulation.setDeviceMetricsOverride
#        （viewport 设为面板尺寸，截图 1:1 不变形）+ Page.startScreencast → 变化帧直接上屏
curl -s -X POST http://127.0.0.1:17865/input -H 'Content-Type: application/json' -d '{"type":"click","x":640,"y":450}'
# type: click|move|scroll|key|type
#   click {x,y} / move {x,y} / scroll {x,y,delta_y} / key {key:"Enter"} / type {text:"中文"}
# 坐标是浏览器 viewport 坐标（与面板 1:1，无需换算）

# 侧车的 SSE /screencast 仍在（直连不可用时的退化路径），面板默认不用它：
curl -s http://127.0.0.1:17865/screencast    # SSE 推流 JPEG 帧（旧式，仅回退用）
```

### 诊断内容（核心：比 iframe 强，可读动态渲染后的文字）
```bash
curl -s "http://127.0.0.1:17865/content?max_chars=60000"          # 页面纯净 Markdown + 统计
curl -s http://127.0.0.1:17865/screenshot -o /tmp/page.png        # 截图 PNG
curl -s "http://127.0.0.1:17865/screenshot?json=1&full_page=true" # 全页截图(base64)
```

### 交互（selector 支持 CSS 选择器，找不到时按可见文本模糊匹配）
```bash
curl -s -X POST http://127.0.0.1:17865/click -H 'Content-Type: application/json' -d '{"selector":"#go"}'          # 点击（也支持按文字："提交"）
curl -s -X POST http://127.0.0.1:17865/type  -H 'Content-Type: application/json' -d '{"selector":"#name","text":"张三","clear":true}'
curl -s -X POST http://127.0.0.1:17865/press -H 'Content-Type: application/json' -d '{"key":"Enter"}'             # Enter/Escape/Tab
curl -s -X POST http://127.0.0.1:17865/scroll -H 'Content-Type: application/json' -d '{"direction":"down"}'      # up/down/top/bottom
```

### LLM 驱动（把任务交给 browser-use Agent）
```bash
curl -s -X POST http://127.0.0.1:17865/agent -H 'Content-Type: application/json' -d '{
  "task":"打开 https://xxx，搜索 XX，把第一条结果标题告诉我",
  "llm":{"model":"Qwen/Qwen3-VL-8B-Instruct","api_key":"<key>","base_url":"https://api-inference.modelscope.cn/v1"},
  "max_steps":15
}'
```
- `llm` 可省略（用环境变量 `PI_BROWSER_USE_MODEL/API_KEY/BASE_URL`）。
- 返回 `{ok, final_url, output, is_done, actions[]}`；`actions` 是 agent 实际执行的动作序列。
- LLM 配置可从 pi 的 `~/.pi/agent/models.json` 读（providers[].baseUrl/apiKey/models[].id）。

### 其他
```bash
curl -s http://127.0.0.1:17865/health   # 状态
curl -s -X POST http://127.0.0.1:17865/close   # 关闭浏览器
```

> 原生 WebContentsView 模式下 `/screencast` 和 LLM 驱动的 `/agent` 暂不可用
> （面板本身就是页面，无需镜像；agent 用 `open/content/screenshot/click/...`
> 即可完成诊断和操控）。

## 建议流程（诊断页面）

1. `open` 打开目标 URL → `url` 确认。
2. `content` 读页面 Markdown（诊断主要内容）。
3. 需要细节/交互：`screenshot` 看图 → `click/type/scroll` 操作 → 再 `content`。
4. 复杂任务（多步表单、搜索）：直接 `agent` 交给 LLM 驱动，读 `output`。

## 注意

- 侧车默认用 **headless** Chrome（干净参数，无自动化标记；浏览器实时镜像内嵌在右侧面板）。设 `PI_BROWSER_USE_HEADLESS=0` 可恢复有头窗口（反爬更强，会弹出可见 Chrome）。
- 侧车是**独立 profile 的匿名会话**，需要登录的站点会显示未登录；登录状态在 `.browser-profile/` 里持久化（下次重启仍在）。
- `click`/`type` 找不到元素返回 404；此时先 `content` 或 `screenshot` 看实际 DOM 再调整选择器。
- 同一时间只有一个浏览器会话（串行操作），`agent` 运行时其他操作会排队等待。
- **会话自愈**：Chrome 意外退出/卡死时，下一次请求自动销毁旧会话并重建新 Chrome（几秒内恢复，不挂起）。
- 侧车只绑定 127.0.0.1，别暴露到局域网。
