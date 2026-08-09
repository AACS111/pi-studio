---
name: web-preview
description: "在 pi-studio 右侧面板打开网页浏览器（Codex 式网页预览）。当用户要求「打开网页 / 打开浏览器 / 预览页面 / 看看效果」，或需要展示正在运行的 web 应用（如刚启动的 dev server）、在线文档、图表页时使用。通过 POST /api/browser 通知 pi-studio 在右侧面板打开/跳转到指定 URL。Use when the user wants a web page opened in the pi-studio right-panel browser (Codex-style preview) — preview a running dev server, view a docs page, or show any web page. Notify pi-studio via POST /api/browser."
---

# 在右侧面板打开网页（web-preview）

pi-studio 右侧面板有一个**浏览器标签**（类似 Codex 的预览面板）：用户可手动输入网址，agent 也可以把网页「推」到面板里。面板通过服务端代理渲染任意网站（自动去除 X-Frame-Options/CSP 限制），所以即使目标站点禁止 iframe 嵌入也能正常显示。

## 打开网页

用 curl POST 到 pi-studio 的浏览器标记接口（dev 端口见 package.json 的 `dev` script，默认 **10141**）：

```bash
curl -s -X POST http://localhost:10141/api/browser \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:5173","title":"Vite dev server"}'
```

- `url`（必填）：http/https 地址；可省略协议（自动补 https）。
- `title`（可选）：标签页显示名；缺省用域名。
- 面板若已有关闭会自动打开；同一 URL 会复用已有标签页。
- pi-studio 前台每 3 秒轮询一次该接口，有新的 marker 就自动打开/跳转，随后清除——所以**每次要打开就 POST 一次**即可，无需关心去重。

## 典型场景

1. **预览刚启动的 dev server**：`npm run dev` 起来后（注意后台启动要等就绪再 POST，或先 curl 探测端口通了再通知），POST 到面板让用户直接看。
2. **展示文档/图表页**：POST 目标 URL。
3. **用户要求看某个网站**：先确认 URL（或搜索/猜测），POST 后询问是否符合预期。

## 验证

- `GET /api/browser` 返回当前 marker；未设置时返回 `{id:null,url:null,...}`。
- 面板 iframe 内无法直接读取页面内容（沙箱隔离）——如需确认页面渲染结果，可改用 `curl` 直接抓取页面源码或截图验证，不要在面板里依赖 DOM 检查。
- 登录态页面：代理是匿名抓取（不转发浏览器 Cookie），需要登录的站点在面板里可能显示未登录状态，属正常。

## 冒烟测试

`scripts/browser-panel-smoke.mjs`（需 dev server 运行在 10141 + 本机 Chrome）：

```bash
node .agents/skills/web-preview/scripts/browser-panel-smoke.mjs
```

验证：POST marker → 面板自动打开网页标签 → iframe 走代理加载 → 地址栏导航。输出 `SMOKE_OK` 即通过。

`scripts/browser-console-smoke.mjs`（另需侧车 17865 运行）：

```bash
node .agents/skills/web-preview/scripts/browser-console-smoke.mjs
```

验证：「Agent 控制台」实时帧渲染 → 点击镜像图片能真实点中侧车浏览器里的按钮 → 地址栏导航驱动真实浏览器。输出 `CONSOLE_SMOKE_OK` 即通过。

`scripts/browser-zhihu-fallback-smoke.mjs`（另需侧车 + 可访问知乎的网络）：

```bash
node .agents/skills/web-preview/scripts/browser-zhihu-fallback-smoke.mjs
```

验证：agent 推送反爬 URL（知乎）→ 代理预检 403 → 面板**自动切换**到 Agent 控制台实时镜像（真实 Chrome 已通过挑战）→ 镜像内滚轮可用。输出 `AUTO_FALLBACK_OK` 即通过。

## 限制（提前告知用户，避免误解）

- 页面脚本无法读写 pi-studio 自身的数据（iframe 沙箱为不透明源），这是安全设计。
- 极动态的 SPA（大量 `fetch('/api/...')`、WebSocket）在代理下部分功能可能失效；数据抓取仍建议用 curl/无头浏览器。
- **强反爬站点（如知乎 www 链接的 zse-ck JS 挑战）iframe 代理打不开**——服务端 fetch 无法执行 JS 挑战。此时改用 `browser-control` skill：侧车用**干净的真实 Chrome**（headless，面板即窗口），能通过挑战；在右侧面板网页标签里点「**Agent 控制台**」即可看到侧车浏览器 —— 现在是**实时镜像**（SSE 推流），可以**直接点击/滚轮/键盘操作**它，和 agent 共用同一会话。
- 若侧车未启动，控制台会显示离线提示：`tools/browser-use-server/start.bat` 启动即可（会话死掉会自动重建，无需重启）。
