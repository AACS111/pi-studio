# 架构

## 两种运行形态

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

## 请求链路（与 pi 一致，浏览器/桌面通用）

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
