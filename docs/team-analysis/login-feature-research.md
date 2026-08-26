# 用户登录功能 — 调研报告（researcher）

> 角色：researcher｜任务：TASK-001 帮我实现一个用户登录功能
> 日期：2026-08-25｜项目：Pi Studio（@aacs111/pi-studio v0.8.6）
> 结论依据均来自项目源码/文档/测试，已注明来源。

---

## 0. 一句话结论

**Pi Studio 是本地单用户开发工具（无多用户账号体系），现状已经有一个「可选的应用访问保护」——HTTP Basic Auth（`lib/web-auth.ts` + `proxy.ts`），由环境变量 `PI_WEB_PASSWORD` 开启；但它是「浏览器原生弹窗 + 每请求校验」，没有独立的登录页面、没有会话持久化（cookie/token）。**

因此「实现用户登录功能」的**最合理落点是：把现有 Basic Auth 升级/扩展为一个「登录页 + 会话 cookie 持久化」的伪登录系统**，而非引入多用户账号/注册体系（该工具定位是本地工作台，无远程多租户需求）。

---

## 1. 现状：项目里已存在的三类「认证/安全」机制

### 1.1 应用访问保护：HTTP Basic Auth（最相关）
- **实现**：`lib/web-auth.ts` + `proxy.ts`
- **开关**：设置环境变量 `PI_WEB_PASSWORD`（非空字符串）即启用。
- **用户名**：`lib/web-auth.ts:3` 硬编码 `export const PI_WEB_AUTH_USERNAME = "pi"`；
  - ⚠️ 与 `docs/agents/formats.md:36` 描述「`PI_WEB_PASSWORD` / `PI_WEB_AUTH_USERNAME` 可选（用户名默认 `pi`）」**不一致**：代码里 `PI_WEB_AUTH_USERNAME` 是 `const "pi"`，**不读环境变量**。文档写「默认 pi 可覆盖」，实现是「永远 pi」。→ 需 developer 注意，这是文档与实现的偏差。
- **密码校验**：`lib/web-auth.ts:14-24` 用 `sha256 + timingSafeEqual` 防时序攻击；`isValidBasicAuthorization` 严格检查 `Basic base64` 格式、UTF-8、用户名=`pi` 且密码匹配。
- **保护范围**：`proxy.ts` 的 `config.matcher = ["/", "/api/:path*"]`，即除 API 外的页面和所有 API 都受保护。
- **失败响应**：`proxy.ts:24-31` 返回 `401` + `WWW-Authenticate: Basic realm="Pi Studio", charset="UTF-8"`，触发浏览器原生登录弹窗。
- **已有测试**：`lib/web-auth.test.mjs`（6 个用例：启用条件、username/password 匹配、UTF-8 密码、畸形值拒绝、未启用不认证）。全部通过。
- **本质**：无状态 Basic Auth，每次请求都带 Authorization 头校验，**除非启用否则完全不生效**（默认无密码，本地直接可用）。

### 1.2 模型提供商 OAuth（与「用户登录」无关，易混淆）
- **实现**：`app/api/auth/providers/`、`app/api/auth/login/[provider]`、`app/api/auth/logout/[provider]`、`app/api/auth/api-key/[provider]`、`app/api/auth/all-providers/`
- **用途**：为 AI 模型（Anthropic / OpenAI / GitHub Copilot 等）做 OAuth 登录/登出、API key 管理。`lib/provider-credential-store.ts` 持久化到数据目录。
- **重要**：这是「连接外部 AI 服务的认证」，**不是应用用户登录**，请勿混淆。

### 1.3 请求安全（Host/Origin 校验，非登录）
- **实现**：`lib/request-security.ts`
- **用途**：`isApiRequestHostAllowed`（防 DNS rebinding，仅信任回环/IP 字面量/绑定 hostname/`PI_WEB_ALLOWED_HOSTS`）+ `isApiRequestOriginAllowed`（防 CSRF/cross-site）。
- 这是安全基础层，新增登录体系须与它协同，不能绕过。

---

## 2. 缺口分析（现状 vs 用户期待的「登录」）

| 维度 | 现状 | 用户「登录功能」期望 | 缺口 |
| --- | --- | --- | --- |
| 登录界面 | 无独立页面，只有浏览器原生 Basic 弹窗 | 自绘登录页 | **缺** |
| 会话状态 | 无状态，每请求 Basic 认证 | 登录一次，会话保持 | **缺**（无 cookie/token） |
| 持久化 | 密码仅存环境变量 | 可配置/持久化密码与会话 | **缺持久化入口** |
| 账号体系 | 单用户 `pi` 硬编码 | 单用户即可 | 够用，但用户名不可配 |
| 登出 | 浏览器身份失效即可 | 显式登出按钮 | **缺** |
| 多用户/注册 | 无 | 一般不需要 | 工具定位不需要 |

- 页面层面：`find app -iname "*login*"` 仅命中 `app/api/auth/login/[provider]`（API），**无任何登录页组件**。`components/` 下无 `*login*`/`*auth*` 组件。
- 会话持久化：全项目无 `cookie`/`session token` 机制（仅 provider OAuth 的 in-memory callback map）。

---

## 3. 建议实现路径（供 developer 落地参考）

### 方案 A（推荐）：Basic Auth → 登录页 + 会话 cookie
1. **复用校验**：沿用 `lib/web-auth.ts` 的 `sha256 + timingSafeEqual` 密码校验（`verifyPassword`），不重写密码逻辑。
2. **新增 API**：
   - `POST /api/auth/login`：body 传 `{ password }`（用户名固定 `pi` 或复用 `PI_WEB_AUTH_USERNAME`），校验通过后颁发 **HttpOnly + SameSite=Strict/Lax 的 session cookie**。
   - `POST /api/auth/logout`：清除 session。
   - `GET /api/auth/me`：返回当前是否有有效会话，供前端判断。
3. **登录页**：`app/login/page.tsx`（受保护时 `/` 未登录重定向到 `/login`），用 `components/DraggableResizableModal.tsx` 不需要（页面级），用现有 UI 语言（i18n en/zh-CN）。
4. **proxy.ts 改造**：当 `PI_WEB_PASSWORD` 启用时——放行 `/login`、静态资源、`/api/auth/login`（POST）、`/api/auth/me`；其余 `/` 与 `/api/*` 校验 session cookie（或回退支持 Basic Authorization 兼容旧客户端）。
5. **会话存储**：内存 session Map（重启失效，适合本地工具）**或** 持久化到数据目录 `<uploadsDir>/.internal/`（参照 `pi-web-open-file.json` 的落盘惯例）。建议先用内存，后续按需持久化。

### 方案 B（小改）：仅补登录页，仍用 Basic
- 保持 Basic Auth，仅在页面初始化时检测 401 并渲染自绘登录页（模拟 Basic 弹窗）。改动最小，但没有真正会话。

### 取舍
- **推荐 A**：满足「登录页 + 会话保持 + 登出」，同时保留 Basic 兼容（旧客户端/curl 仍可用）。
- **不推荐**引入多用户/注册体系：工具定位本地单用户，过度设计。

---

## 4. 风险

1. **session 安全**：改用 cookie 后须注意 HttpOnly、SameSite、CSRF（现有 `request-security.ts` 已管 origin，需协同）；避免把 session 放 localStorage（XSS 风险）。
2. **回退兼容**：若一刀切去掉 Basic，会破坏已有用 `curl`/脚本带 `Authorization: Basic` 的调用。建议 proxy 同时接受 session cookie 或 Basic header。
3. **Electron 模式**：`npm run dev:electron` / 打包应用的内置服务走主进程启动，需确认登录逻辑在桌面壳下不阻断本地体验（本地回环建议默认免登录或记住会话）。
4. **文档偏差**：`docs/agents/formats.md` 说用户名可配，代码实际硬编码 `pi`。落地时应统一：要么让 `PI_WEB_AUTH_USERNAME` 真正读 env，要么把文档改为「用户名固定 pi」。
5. **数据目录依赖**：`.pi-web-config.json` 的 `uploadsDir` 存上传/内部状态；若会话持久化放这里，需遵循原子写（`lib/atomic-file.ts`）以防破损。
6. **i18n**：新增登录文案需同时加 en/zh（现有 `team.*`、`files.*` 等键位体系），否则登录页缺翻译。

---

## 5. 依据来源（可验证）

- **Basic Auth 实现**：`lib/web-auth.ts`（全文）、`proxy.ts`（全文）
- **请求安全**：`lib/request-security.ts`
- **模型提供商 OAuth**：`app/api/auth/providers/route.ts`、`app/api/auth/login/[provider]/route.ts`、`lib/provider-credential-store.ts`
- **数据目录**：`.pi-web-config.json`（`uploadsDir: "D:\zheng\data\APP\pi"`）
- **环境变量文档**：`docs/agents/formats.md:35-37`
- **设计决策/文件地图**：`docs/agents/design-decisions.md:114`、`docs/agents/file-map.md:165-167`
- **已有测试**：`lib/web-auth.test.mjs`（6 用例，全通过）
- **页面/组件落点**：`find app -iname "*login*"` 仅命中 API；`components/` 下无 login/auth 组件

---

## 6. 给 developer 的交接要点

- 需求边界：**单用户登录页 + 会话 cookie**，不做多用户/注册。
- 复用 `lib/web-auth.ts` 的密码校验，新增 `/api/auth/login|logout|me` 三个 API + `app/login/page.tsx`。
- 改造 `proxy.ts` 放行登录相关路径，其余走会话校验，**保留 Basic 兼容**。
- 会话先内存存储，持久化到 `<uploadsDir>/.internal/` 作为后续增强。
- 统一 `PI_WEB_AUTH_USERNAME` 文档与实现（读 env 或改文档）。
- 遵循铁律：改动过 `tsc --noEmit` + lint；新增 i18n en/zh。
