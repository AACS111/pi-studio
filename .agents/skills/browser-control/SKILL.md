---
name: browser-control
description: "控制右侧浏览器（Electron 原生 WebContentsView）并诊断页面内容。支持语义快照（/snapshot 返回 ref/role/name/value）、评分定位器（精确文本>aria>placeholder>testid>contains，歧义返回 409+候选）、批量执行（/execute 一次 JS 上下文完成多步动作：fill/select/click/check/wait/assert）、高级动作（/select 原生下拉 + Ant Design/Element Plus combobox）、条件等待与断言（/wait /assert）、智能打开（/open 支持 wait:\"dom\" 与 readyWhen + 内嵌 snapshot）。仅 Electron 桌面模式可用（npm run dev:electron / 打包应用）；npm run dev 纯浏览器模式不支持右侧浏览器。Use when the user wants you to interact with a live website (fill a form, click through, check dynamic content), take a screenshot of a page, or extract readable page text. Only works in the Electron desktop app (npm run dev:electron or packaged build); plain npm run dev browser mode has no right-panel browser."
---

# 控制浏览器（browser-control）

右侧面板浏览器由 **Electron 原生 WebContentsView** 渲染，`electron/bridge.cjs` 起 HTTP 控制桥（127.0.0.1 随机端口）暴露语义接口。

| 项目 | 说明 |
|---|---|
| 渲染 | 原生 WebContentsView（页面由 Chromium 直接合成） |
| 控制 | Electron 主进程控制桥（CDP / executeJavaScript） |
| 语义接口 | ✅ snapshot / execute / select / fill / check / wait / assert |
| 可用形态 | `npm run dev:electron`、打包应用（exe） |
| 不可用形态 | `npm run dev` 纯浏览器模式（无桥，接口返回 502） |

## ⚠️ 核心工作流（先读这里）

**不要一步一 curl**。正确流程：

```
1. observe  →  /snapshot  拿到页面交互元素（ref/role/name/value）
2. plan     →  在脑内规划多步动作（哪些元素需要操作、按什么顺序）
3. act      →  /execute 一次批量执行这些确定性动作（同一个 JS 执行上下文）
4. verify   →  /wait 或 /assert 确认结果；必要时 /content /screenshot
```

**规则：凡是确定性的连续动作，必须合并进一次 `/execute`。** 例如“供应商选华为、状态选已审核、点查询”是一个 `execute`，不是三次 `click/select`。

```bash
# ✅ GOOD：observe → 一次 execute
curl -s -X POST $base/snapshot
# → e2=供应商(e2), e3=状态(combobox), e4=查询(button)
curl -s -X POST $base/execute -H 'Content-Type: application/json' -d '{
  "snapshotId": "s_xxx",
  "actions": [
    {"type":"select","ref":"e2","value":"华为"},
    {"type":"select","ref":"e3","value":"已审核"},
    {"type":"click","ref":"e4"}
  ]
}'
curl -s -X POST $base/wait -H 'Content-Type: application/json' -d '{"for":{"text":"查询完成"},"timeout":5000}'

# ❌ BAD：每步一次往返
# click 供应商 → observe → click 华为 → observe → click 状态 → observe → ...（禁止）
```

`/execute` 返回每一步结果（`completed/failed/results[]`）以及 `snapshotInvalidated`：
- 页面 DOM 没变（如勾选 checkbox）→ `snapshotInvalidated:false`，**可以继续用同一个 snapshotId 操作**。
- 页面变了（如点击后表格刷新）→ `snapshotInvalidated:true`，**必须先重新 `/snapshot`**，旧 ref 已失效。

## 发现控制桥地址

先按顺序取 `baseUrl`：

1. 环境变量 `PI_WEB_BROWSER_BRIDGE_URL`（Electron 主进程已设置）；
2. 桥标记文件 `pi-web-uploads/.internal/pi-web-browser-bridge.json` 的 `baseUrl`（Electron 数据目录：打包版 `%APPDATA%/Pi Studio/pi-web-uploads`，dev 版 `%APPDATA%/Pi Studio Dev/pi-web-uploads`）。

PowerShell 示例：

```powershell
$dataDir = if ($env:PI_WEB_UPLOADS_DIR) { $env:PI_WEB_UPLOADS_DIR }
  elseif (Test-Path "pi-web-uploads") { (Resolve-Path "pi-web-uploads").Path }
  else { Join-Path $env:APPDATA "Pi Studio\pi-web-uploads" }
$marker = Join-Path $dataDir ".internal\pi-web-browser-bridge.json"
$base = if ($env:PI_WEB_BROWSER_BRIDGE_URL) { $env:PI_WEB_BROWSER_BRIDGE_URL }
  elseif (Test-Path $marker) { (Get-Content $marker -Raw | ConvertFrom-Json).baseUrl }
  else { throw "browser bridge not found — 仅在 Electron 桌面模式下可用" }
```

> 桥标记可能过期（Electron 重启后端口会变）——`$base` 连不上时，用 `netstat -ano | grep LISTENING` 找 Electron 主进程实际监听的 HTTP 端口，或直接查 CDP `http://127.0.0.1:9222/json`（dev 用 9223）确认 WebContentsView 是否存活。也可走 pi-studio 同源代理 `/api/browser/control/<path>`（无 CORS 问题，推荐 agent 用这个）。

## API（全部 JSON；`baseUrl` 见上方发现逻辑）

### ① 语义观察：/snapshot（推荐替代 /content）

返回**高价值交互元素**（button/input/textarea/select/combobox/checkbox/radio/link/tab/option/contenteditable，隐藏与零尺寸元素自动过滤）。图标按钮（无文本但有 `title` / svg `<title>`）的名称会取 title，语义定位也能命中：

```bash
curl -s "$base/snapshot"            # 默认最多 300 个元素；?max=500 可调
```

```json
{
  "snapshotId": "s_172329",
  "url": "http://.../order",
  "title": "采购订单",
  "elements": [
    {"ref":"e0","tag":"input","role":"textbox","name":"订单号","value":"","placeholder":"订单号","disabled":false,"checked":false},
    {"ref":"e1","tag":"select","role":"combobox","name":"","value":"全部","placeholder":"","disabled":false,"checked":false},
    {"ref":"e2","tag":"button","role":"button","name":"查询","value":"","placeholder":"","disabled":false,"checked":false}
  ]
}
```

- `ref`（`e0`、`e1`…）只在**该 snapshotId 对应的 DOM 签名**下有效；页面变化后必须重新 snapshot。
- 之后用 `{"type":"click","ref":"e2"}` 精确操作，避免语义猜测。
- 需要读正文内容/链接时仍用 `/content`。

### ② 批量执行：/execute（最常用）

一次 HTTP + 一次 JS 上下文完成多个动作，**不要拆成多次调用**。

**auto-wait（2026-08-12 新增）**：`click/fill/select/check/press/focus` 执行前会等待元素可交互（可见 + 未禁用 + 可接收指针事件）且几何稳定（动画/懒加载中的元素会移动），超时默认 4s（`"wait": 8000` 可调）。等不到则返回 `NOT_ACTIONABLE`，避免“元素没加载完就点空”。

```bash
curl -s -X POST $base/execute -H 'Content-Type: application/json' -d '{
  "snapshotId": "s_172329",
  "actions": [
    {"type":"fill","ref":"e0","value":"PO001"},
    {"type":"select","ref":"e1","value":"华为"},
    {"type":"click","ref":"e2"}
  ]
}'
```

action.type 支持：

| type | 说明 |
|---|---|
| `click` | 点击（滚动到视野中央后原生 click） |
| `fill` | 填入/替换输入框值（React/Vue 兼容 native setter + input/change 事件） |
| `select` | 见下方「select 语义」：原生 select / Ant Design / Element Plus / 自研 combobox |
| `check` | 勾选/取消勾选 checkbox/radio（`"value": true/false`） |
| `press` | 在目标元素上按按键（keydown/keyup；Enter/Tab/方向键建议改用独立 /press 走 CDP） |
| `scroll` | 滚动：`{"target":...}` 滚到元素；`{"value":"up|down|top|bottom"}` 滚窗口 |
| `wait` | 等待条件：`{"for":{"selector":"#app"|"text":"..."|"url":"..."|"role":"combobox","name":"供应商"},"timeout":5000}` |
| `assert` | 断言：`{"target":{...},"state":"visible|enabled|disabled|checked|unchecked|selected|value"}` 或 `{"text":"查询成功"}`（assert 失败不中断后续动作） |

定位方式（每个 action 三选一）：
- `ref`：`"e0"`（快照 ref，最精确）
- `target`：字符串 `"查询"` 或对象 `{"role":"button","name":"查询","value":"..."}`
- （兼容）`selector`：CSS 选择器 `"#ord"`

返回：

```json
{
  "ok": true,
  "completed": 3,
  "failed": 0,
  "results": [
    {"ok":true,"action":"fill","ref":"e0","value":"PO001"},
    {"ok":true,"action":"select","ref":"e1","method":"dropdown","value":"华为"},
    {"ok":true,"action":"click","ref":"e2","tag":"button","name":"查询"}
  ],
  "snapshotInvalidated": true,
  "snapshotId": "s_172329",
  "url": "http://...",
  "title": "采购订单"
}
```

- 某个动作失败默认**中断**（除非该动作带 `"stopOnError": false`）；失败原因见 `results[].error`（`ELEMENT_NOT_FOUND` / `REF_STALE` / `AMBIGUOUS` / `OPTION_NOT_FOUND`）。
- `snapshotInvalidated:true` → 重新 `/snapshot` 再继续。

### select 语义（原生下拉 + 框架组件）

`/execute` 里的 `{"type":"select","ref":"e1","value":"华为"}` 内部自动判断：
- `<select>` → 原生设置选中项 + change 事件（`method:"native"`）
- `[role=combobox]` / `.ant-select` / `.el-select` → 点击打开下拉 → 精确匹配 option 文本/aria-label/title → 点击（`method:"dropdown"`）
- 其它输入框 → 直接设值（`method:"input"`）
- 找不到 option → `OPTION_NOT_FOUND`

### ③ 单动作快捷端点

```bash
curl -s -X POST $base/click  -H 'Content-Type: application/json' -d '{"target":{"role":"button","name":"查询"}}'   # 或 {"ref":"e2"} / {"selector":"#go"}
curl -s -X POST $base/type   -H 'Content-Type: application/json' -d '{"selector":"#name","text":"张三","clear":true}'
curl -s -X POST $base/fill   -H 'Content-Type: application/json' -d '{"ref":"e0","value":"PO001"}'
curl -s -X POST $base/select -H 'Content-Type: application/json' -d '{"selector":"#status","value":"已审核"}'
curl -s -X POST $base/check  -H 'Content-Type: application/json' -d '{"ref":"e5","value":true}'
```

- `click`/`fill`/`select`/`check` 都支持 `ref` / `target` / `selector` 三种定位。
- `type` 保持旧语义：`clear:false` 追加，`clear:true` 替换；`fill` 永远替换。
- 找不到元素 → 404；**歧义（多个同分候选）→ 409 + `candidates` 列表**，此时改用 ref 或更精确的 target 重试。

### ④ 条件等待与断言

```bash
curl -s -X POST $base/wait -H 'Content-Type: application/json' -d '{"for":{"text":"查询完成"},"timeout":5000}'
# for 支持 selector / text / url / {role,name}；返回 {ok, satisfied}
curl -s -X POST $base/assert -H 'Content-Type: application/json' -d '{"target":{"name":"查询"},"state":"visible"}'
curl -s -X POST $base/assert -H 'Content-Type: application/json' -d '{"text":"保存成功"}'
```

### ⑤ 智能打开：/open（支持 readyWhen + 内嵌 snapshot）

```bash
curl -s -X POST $base/open -H 'Content-Type: application/json' -d '{"url":"http://localhost/order","wait":"dom","snapshot":true}'
```

- `wait`（默认 `"dom"`）：`"dom"` = dom-ready 就返回（不等图片/iframe/广告/WebSocket，MAS/MOM 这类页面框架先出即可操作）；`"finish"` = did-finish-load。
- `readyWhen`：条件满足才返回：
  ```bash
  curl -s -X POST $base/open -H 'Content-Type: application/json' -d '{
    "url":"http://localhost/order",
    "readyWhen":{"selector":"#app"},
    "readyTimeout":10000
  }'
  # 或 {"readyWhen":{"role":"button","name":"查询"}} / {"readyWhen":"#app"} / {"readyWhen":{"text":"登录"}}
  ```
- `"snapshot":true` → 返回里直接带 `snapshotId` + `elements`，open 和 observe 一次完成。

### ⑥ 基础/底层接口（保留兼容）
```bash
curl -s -X POST $base/back            # 后退（返回 {moved:true/false}）
curl -s -X POST $base/forward         # 前进
curl -s -X POST $base/reload          # 刷新
curl -s "$base/url"                   # 当前 {url,title}
curl -s "$base/content?max_chars=60000" # 页面纯净 Markdown + 统计（读正文用）
curl -s "$base/screenshot?json=1&full_page=true" # 截图 PNG(base64)
curl -s -X POST $base/press -H 'Content-Type: application/json' -d '{"key":"Enter"}'   # 真实 CDP 按键，可带 {"ref":"e0"} 先聚焦
curl -s -X POST $base/scroll -H 'Content-Type: application/json' -d '{"direction":"down"}'  # up/down/top/bottom
curl -s -X POST $base/input -H 'Content-Type: application/json' -d '{"type":"click","x":640,"y":450}'
# input type: click|move|scroll|key|type（坐标是浏览器 viewport 坐标）
```

- `/press` 走**真实 Chromium 键盘输入**（CDP `Input.dispatchKeyEvent`，Enter 携带 `\r` 触发原生表单提交），不是合成 DOM 事件——对 Ant Design / Element Plus / Vue / React 组件更可靠。可先指定 `{"ref":"e0","key":"Enter"}` 把焦点放到目标再按键。
- 语义操作（click/fill/select/check/press）**不等待页面加载**，点击后若发生导航，用 `/wait` 等新页面出现。

### ⑦ evaluate（低层逃生舱，canvas/自研组件首选）

任意 JS 求值，**读 canvas 应用内部状态（如 Univer 的 FUniver 实例）、自研组件适配都走这里**（语义定位对 canvas 内容无效）。支持三种写法：

```bash
# 1) 普通表达式
curl -s -X POST $base/evaluate -H 'Content-Type: application/json' -d '{"expression":"document.title"}'
# 2) 函数式 + args 传参（省去每次内嵌长参数）
curl -s -X POST $base/evaluate -H 'Content-Type: application/json' -d '{"expression":"(a,b) => a + b", "args":[2,3]}'
# 3) 直接传一个匿名函数体
curl -s -X POST $base/evaluate -H 'Content-Type: application/json' -d '{"expression":"() => ({ n: document.querySelectorAll(\"canvas\").length })"}'
```

- 支持异步表达式（`async () => …`）；默认 15s 超时，`{"timeoutMs": 5000}` 可调（上限 120s）。
- JS 抛错返回 `{"ok":false,"error":"..."}`（不会整个请求 500）。

## 建议流程（诊断 + 操作页面）

1. `open`（带 `snapshot:true`）→ 一次拿到页面 + 交互元素。
2. 读正文用 `content`；看不清布局/需要视觉确认用 `screenshot`。
3. 多个确定性操作 → **一次 `/execute`**。
4. `/wait` 等待结果（表格加载、提示出现），`/assert` 校验。
5. 页面变化（`snapshotInvalidated`）→ 重新 `/snapshot`。

## 注意

- **snapshotId 有效期**：页面 DOM 变化后旧 ref 失效，必须重新 `/snapshot`。execute 返回的 `snapshotInvalidated:true` 就是信号。
- **优先用 ref**：语义 target 有歧义时返回 409 + 候选，改用 ref 精确操作。
- 原生浏览器与用户会话同源（同一 Electron 实例的 WebContentsView），登录态取决于页面自身。
- 同一时间只有一个浏览器会话（串行操作），`agent` 运行时其他操作会排队等待。
- **会话自愈**：WebContentsView 意外退出/卡死时，下一次请求自动重建（几秒内恢复，不挂起）。
- 桥只绑定 127.0.0.1，别暴露到局域网。
- **npm run dev 纯浏览器模式不支持右侧浏览器**：`/api/browser/control/*` 返回 502。遇到时先确认用户是否在用 Electron 桌面版。
