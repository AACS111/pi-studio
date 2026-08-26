# 用户登录功能 — 测试验证报告

> 角色：tester｜任务：TASK-003 验证用户登录功能
> 日期：2026-08-25｜项目：Pi Studio（@aacs111/pi-studio v0.8.6）
> 结论：**失败（fail）** —— 开发角色未交付登录功能实现产物。

---

## 验证范围

依据 researcher 调研报告 `docs/team-analysis/login-feature-research.md` 与 leader 任务拆解，
「用户登录功能」应包含：

1. 独立登录页：`app/login/page.tsx`
2. 登录 API：`POST /api/auth/login`（用户名固定 `pi`，校验密码后颁发会话 cookie）
3. 登出 API：`POST /api/auth/logout`
4. 会话检查 API：`GET /api/auth/me`
5. 会话持久化：cookie / 内存或数据目录存储
6. `proxy.ts` 改造：放行登录相关路径，其余路径校验会话（保留 Basic Auth 兼容）
7. i18n 文案：`lib/i18n/messages/en.ts`、`lib/i18n/messages/zh-CN.ts`
8. 质量门槛：`tsc --noEmit` 与 `npm run lint` 通过

---

## 验证方法与结果（本次实测）

### 1. 文件存在性检查

| 验收项 | 期望路径/文件 | 实际结果 |
|---|---|---|
| 登录页面 | `app/login/page.tsx` | **不存在**（`find app/login` 无结果） |
| 登录 API | `app/api/auth/login/route.ts`（无 `[provider]` 动态段） | **不存在**；仅有 OAuth 用的 `app/api/auth/login/[provider]/route.ts` |
| 登出 API | `app/api/auth/logout/route.ts` | **不存在**；仅有 OAuth 用的 `app/api/auth/logout/[provider]/route.ts` |
| 会话检查 API | `app/api/auth/me/route.ts` | **不存在** |
| cookie/session 逻辑 | 代码中存在 cookie/session 相关实现 | **不存在**；全项目无新增 cookie/session 代码 |

### 2. 现有认证代码检查

- `lib/web-auth.ts`：仍是原始 HTTP Basic Auth 实现，`PI_WEB_AUTH_USERNAME` 硬编码为 `"pi"`，无 cookie/session 逻辑。
- `proxy.ts`：仍使用 `WWW-Authenticate: Basic` 响应 401，未放行 `/login`、`/api/auth/login` 等路径，未读取 cookie。
- `app/api/auth/login/[provider]/route.ts`：仅用于模型提供商 OAuth 登录，与用户登录功能无关。

### 3. Git 工作区检查

`git status --short` 显示大量项目组多智能体相关改动，但**没有任何与登录功能相关的新增或修改文件**。

### 4. 现有测试基线

运行现有认证测试：

```bash
node lib/web-auth.test.mjs
```

结果：5/5 通过。该测试仅覆盖 HTTP Basic Auth，**不包含登录页、cookie 会话、登录/登出 API 的测试**。

### 5. TypeScript / Lint

由于登录功能未实现，无相关代码可检查；本次验证不重新跑全量 `tsc/lint`（irrelevant）。

---

## 问题清单

### P0 — 未交付登录页

- **复现步骤**：在项目根目录执行 `find app/login -type d` 或 `ls app/login`。
- **期望**：存在 `app/login/page.tsx`，提供用户名/密码输入框与登录按钮。
- **实际**：`app/login` 目录不存在；唯一匹配是 OAuth 的 `app/api/auth/login/[provider]`。
- **严重程度**：阻塞（P0）。

### P0 — 未交付登录/登出/会话检查 API

- **复现步骤**：检查 `app/api/auth/` 下是否包含 `login/route.ts`、`logout/route.ts`、`me/route.ts`（非 `[provider]` 动态路由）。
- **期望**：存在上述三个 API，支持密码校验、cookie 颁发与清除、会话状态查询。
- **实际**：仅有 `app/api/auth/login/[provider]/route.ts` 与 `app/api/auth/logout/[provider]/route.ts`（OAuth 专用）。
- **严重程度**：阻塞（P0）。

### P0 — 无会话持久化机制

- **复现步骤**：全局搜索 `cookie`、`session`、`set-cookie`。
- **期望**：新增登录相关 cookie/session 实现。
- **实际**：未新增任何 cookie/session 代码；`proxy.ts` 仍每请求校验 Basic Authorization。
- **严重程度**：阻塞（P0）。

### P1 — proxy.ts 未放行登录路径

- **复现步骤**：阅读 `proxy.ts` 的 `config.matcher` 与认证分支。
- **期望**：当 `PI_WEB_PASSWORD` 启用时，放行 `/login`、`/api/auth/login`、`/api/auth/me` 与必要静态资源，其余路径校验会话 cookie 并保留 Basic 兼容。
- **实际**：`proxy.ts` 对所有 `/` 与 `/api/*` 请求强制 Basic Auth，无登录路径白名单。
- **严重程度**：严重（P1）。

### P1 — 缺少 i18n 登录文案

- **复现步骤**：检查 `lib/i18n/messages/en.ts` 与 `zh-CN.ts` 是否新增 `auth.*`/`login.*` 键。
- **期望**：新增登录相关中英双语键。
- **实际**：无新增登录文案。
- **严重程度**：中等（P1）。

---

## 结论

**当前工作区未实现用户要求的「用户登录功能」**。开发角色应交付的登录页、登录/登出/会话 API、cookie 会话机制、`proxy.ts` 改造均未出现。建议退回 developer 重新实现，并依据 researcher 调研报告 `docs/team-analysis/login-feature-research.md` 中的推荐方案 A 落地。

---

## 验证产物

- 本报告：`docs/team-analysis/login-feature-test-report.md`
- 调研报告（实现依据）：`docs/team-analysis/login-feature-research.md`
