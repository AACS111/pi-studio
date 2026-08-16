# DSH → Pi Studio 能力映射与落地计划

## 能力映射表（核心资产，不是 HTTP Proxy）

| DSH seam / 服务 | Pi Studio 实现 | 现有文件 | 状态 |
| --- | --- | --- | --- |
| `ctx.fs` | 允许根校验 + 原子写 | `lib/file-access.ts` / `allowed-roots.ts` | ✅ POC 已跑通（裸 node:fs 版） |
| `ctx.tools` | tool registry（Pi agent 工具） | pi tool registry | ✅ POC 用最小 registry |
| `ctx.systemPrompt` | system prompt 段落 | pi systemPrompt 机制 | ✅ POC 用最小 registry |
| `ctx.skills` | skill 分层 registry | `lib/skills-service.ts` / `DefaultResourceLoader` | Phase 1 |
| `ctx.llm` | models.json + ModelRegistry | `app/api/models*` | Phase 3 |
| `ctx.session` | AgentSession / .jsonl | `lib/rpc-manager.ts` / `session-reader.ts` | Phase 3 |
| `ctx.subprocess` | pi bash 工具 | `lib/bash-output.ts` | Phase 3 |
| `ctx.terminal` | 内置终端 runtime | `lib/terminal-input.ts` | Phase 3 |
| `ctx.git` | git-status / git-changes | `lib/git-status.ts` / `git-changes.ts` | Phase 3 |
| `ctx.browser` | Semantic Browser V2 桥 | `electron/bridge.cjs` | Phase 3 |
| `ctx.credentials` | auth.json | `lib/provider-credential-store.ts` | Phase 3 |
| `ctx.storage` | 数据目录 `.internal/` | `lib/storage-config.ts` | Phase 3 |
| `sandboxPolicy` / `approval` | 允许根 + 项目信任 | `lib/project-trust.ts` | Phase 3（裸后端可暂不实现） |

## 落地阶段

### Phase 0 ✅ 已完成
- 逆向真实包，固化契约（本目录 + `lib/plugins/adapters/dsh/dsh-contract.ts`）。
- **POC 跑通**：真实 `@deepseek-ai/dsh-tool-fs` 脱离 DSH CLI，在真 Cordis +
  Pi 的 `fs` Service 上注册 read/write/edit 并真实读写文件。

### Phase 1 — Skill / Tool / Prompt / Command / Preset（成本最低，收益最高）
- 新增 `lib/plugins/core/`（types / registry / manager / manifest）。
- 新增 `dsh-skill-adapter.ts`：`SKILL.md`/`scripts/`/`references/`/`assets/` → pi skill 布局。
- 新增 `dsh-tool-adapter.ts`：真实 tool 插件 → `ctx.tools` → Pi agent 工具。
- **替换 sidecar**：B 类纯 tool/skill 插件不再需要 `dsh web` 在线。

### Phase 2 — UI 插件（Sidebar/Panel/Widget/StatusBar/Theme）
- `lib/plugins/runtime/ui-runtime.ts` + `components/PluginHost.tsx`。
- `dsh-ui-adapter.ts`：DSH `registerSidebar` → Pi `ui.registerPanel`。
- Electron 白名单 IPC 隔离；Skin 走 CSS 变量映射（`--dsh-*` → `--pi-*`）。

### Phase 3 — Capability 兼容（Terminal/SSH/Git/Browser/Remote）
- 把能力映射表全面落地；terminal 先抽成 Runtime 而非页面组件。
- `PiLlmService` / `PiSessionService` / `PiTerminalService` / `PiBrowserService` / `PiGitService`。

### Phase 4 — 市场 + CompatReport + 移除 sidecar
- `DshMarketPanel` 收敛进多生态 `PluginMarketPanel`；A/B/C 徽章换成
  `CompatReport.score` + `unmapped`。
- 删除 `lib/dsh-manager.ts` 的 web 启动逻辑 + `/api/dsh/start|stop|status`。

## POC 证据

运行时已固化在 `lib/plugins/adapters/dsh/dsh-runtime.ts`（真 Cordis + Pi Service +
`loadPlugin`）。POC 实测（真实 `@deepseek-ai/dsh-tool-fs` 脱离 DSH CLI 跑通）：

```
[1] registered tools: ["read","write","edit"]
[2] read  => {path, offset:1, lines:[{number,text}...], totalLines:3}
[3] write => {operation:"create", before:null, after:"created by pi fs service\n"}
[4] edit  => {before:"created...", after:"edited by pi fs service\n"}
[5] final content => "edited by pi fs service\n"
[6] disposed. POC OK ✔
```

证明：**真实 DSH 插件 + 真实 Cordis + Pi Service = 真实 Tool 注册 + 真实项目文件读写**。
「加载兼容」和「能力兼容」都成立。
