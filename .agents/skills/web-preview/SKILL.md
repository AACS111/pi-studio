---
name: web-preview
description: "在 pi-studio 右侧面板打开网页浏览器（Codex 式网页预览）。当用户要求「打开网页 / 打开浏览器 / 预览页面 / 看看效果」，或需要展示正在运行的 web 应用（如刚启动的 dev server）、在线文档、图表页时使用。通过 POST /api/browser 通知 pi-studio 在右侧面板打开/跳转到指定 URL。注意：右侧浏览器仅在 Electron 桌面模式可用（npm run dev:electron 或打包应用）；npm run dev 纯浏览器模式不支持右侧浏览器。Use when the user wants a web page opened in the pi-studio right-panel browser (Codex-style preview) — preview a running dev server, view a docs page, or show any web page. Notify pi-studio via POST /api/browser. Note: the right-panel browser only works in the Electron desktop app (npm run dev:electron or packaged build); plain npm run dev browser mode does not support it."
---

# 在右侧面板打开网页（web-preview）

pi-studio 右侧面板有一个**浏览器标签**（类似 Codex 的预览面板）：用户可手动输入网址，agent 也可以把网页「推」到面板里。右侧浏览器由 **Electron 原生 WebContentsView** 渲染（`electron/main.cjs` + `bridge.cjs`），语义控制接口（`/snapshot` `/execute` 等）也只有 Electron 模式提供。

> ⚠️ **仅 Electron 桌面模式支持右侧浏览器**：`npm run dev:electron` 或打包应用。`npm run dev` 纯浏览器模式没有原生浏览器与控制桥，面板会显示「仅 Electron 支持」提示。

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
- 在 Electron 模式下，面板里的页面由原生 WebContentsView 渲染，可直接交互（点击/输入/滚动）；agent 观察与操作页面用 `browser-control` skill（`/api/browser/control/*` 语义接口）。

## 限制（提前告知用户，避免误解）

- **npm run dev 纯浏览器模式不支持右侧浏览器**（无 Electron 原生视图与控制桥）。若用户在这种模式下要求打开网页，直接告知请用 `npm run dev:electron` 或打包应用。
- 需要登录的站点：Electron 原生浏览器与用户会话同源，登录态取决于页面自身；未登录会显示登录页，属正常。
- agent 与面板共用同一浏览器会话：agent 用 `browser-control` skill 操作页面时，面板实时可见。
