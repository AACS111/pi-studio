---
name: browser-control
description: "控制真实浏览器（browser-use + 系统 Chrome，headless）并诊断页面内容：打开/跳转页面、点击、输入、按键、滚动、前进后退、刷新、截图、提取页面纯净 Markdown（比 iframe 代理更能诊断动态内容）。agent 通过 curl 调用本地侧车服务（127.0.0.1:17865）。Use when the user wants you to interact with a live website (fill a form, click through, check dynamic content), take a screenshot of a page, or extract readable page text — the browser-use sidecar drives a real headless Chrome and returns clean markdown/screenshots."
---

# 控制浏览器（browser-control）

pi-studio 内置了一个 **browser-use 浏览器控制侧车**（Python FastAPI，驱动系统 Chrome headless）。
它和右侧面板的网页标签互补，但**右侧面板的「Agent 控制台」就是这台真实浏览器的实时镜像**
（SSE 推流 ~5fps，可点/拖/滚/键盘直接操作，和 agent 共用同一会话）：

| | 网页标签（web-preview） | Agent 控制台 / browser-control |
|---|---|---|
| 用途 | 用户自己看页面（iframe 代理） | **真实浏览器**（实时镜像 + agent 操作） |
| 能力 | 只读显示 | 点击/输入/滚动/前进后退/截图/提 Markdown |
| 内容诊断 | 沙箱内不可读 | **可读完整 DOM 纯文本**（/content） |
| 浏览器 | pi-studio 页面的 iframe | 独立 headless Chrome（CDP，无窗口，面板即窗口） |

> 侧车默认 **headless**（浏览器内嵌在右侧面板的实时镜像里，不再弹独立窗口）。
> 需要反爬更强时设 `PI_BROWSER_USE_HEADLESS=0` 恢复有头真实窗口（Codex 同款）。
> 会话僵死自动销毁重建（自愈），请求不会永久挂起。

## 启动侧车

```bash
tools/browser-use-server/start.bat
```

- 端口 **17865**（`PI_BROWSER_USE_PORT` 可改），日志 `tools/browser-use-server/server.log`。
- 首次请求会自动启动 headless Chrome（系统 Chrome，独立 profile，不碰用户浏览器）。
- 侧车未启动时先启动；启动脚本会检测端口已存在则跳过。

## API（全部 JSON；`baseUrl=http://127.0.0.1:17865`）

### 导航
```bash
curl -s -X POST http://127.0.0.1:17865/open -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'   # 打开/跳转
curl -s -X POST http://127.0.0.1:17865/back            # 后退（返回 {moved:true/false}）
curl -s -X POST http://127.0.0.1:17865/forward         # 前进
curl -s -X POST http://127.0.0.1:17865/reload          # 刷新
curl -s http://127.0.0.1:17865/url                     # 当前 {url,title}
```

### 面板实时镜像（右侧面板「Agent 控制台」自动使用）
```bash
curl -s http://127.0.0.1:17865/screencast          # SSE 推流 JPEG 帧（~10fps，面板消费）
curl -s "http://127.0.0.1:17865/screencast?w=800&h=900&dpr=1.25"
#   ?w=&h=&dpr= —— 前端把面板尺寸（CSS px × 屏幕 DPR）传来，侧车用
#   Emulation.setDeviceMetricsOverride 把浏览器 viewport 设成与面板一致：
#   截图 1:1 像素、不变形，点击坐标直接映射（无需缩放换算）。
curl -s -X POST http://127.0.0.1:17865/input -H 'Content-Type: application/json' -d '{"type":"click","x":640,"y":450}'
# type: click|move|scroll|key|type
#   click {x,y} / move {x,y} / scroll {x,y,delta_y} / key {key:"Enter"} / type {text:"中文"}
# 坐标是浏览器 viewport 坐标（与面板 1:1，无需换算）
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
