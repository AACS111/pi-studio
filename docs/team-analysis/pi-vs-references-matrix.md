# Pi Studio ⇄ MetaGPTTest / OpenHarness 多 Agent 能力对比矩阵

> 角色：开发（developer）
> 任务：将 Pi Studio（`@aacs111/pi-studio` v0.8.6，`lib/team/**`）与两参考项目做详细功能矩阵比对，
> 逐项标注 **已有 ✅ / 缺失 ❌ / 部分 ◐**，作为找出「缺陷与不足」的证据底座。
> 参考仓库：`/tmp/MetaGPTTest`（NanGePlus/MetaGPTTest）、`/tmp/OpenHarness`（HKUDS/OpenHarness）。
> 核实方式：本矩阵基于**源码逐行核对**（已读 `lib/team/types.ts`、`executor.ts`、`components/TeamChat.tsx`、
> `app/api/teams/runs/[runId]/*`、OpenHarness `swarm/*.py`、`memory/team.py`、MetaGPT `nangeAGICode/*.py`）。

---

## 一、MetaGPTTest 能力对照（教程框架：SOP + 角色 + 环境 + 通信 + 经济）

| MetaGPTTest 能力 | 说明 | Pi Studio 现状 | 判定 |
|---|---|---|---|
| **SOP（标准作业程序）作为核心编排哲学** | 预定义角色间的先后流程 | `lib/team/` 有 `Transition` + `GatewayDef`（exclusive/parallel/inclusive/merge）+ `WorkflowEditor` 画布 | ✅ 更强（BPMN 式可视化工作流，非 MetaGPT 的线性 SOP） |
| **角色模型 `智能体=LLM+观察+思考+行动+记忆`** | `Role` 基类 | `AgentDef`（id/name/role/model/systemPrompt/toolNames/skillIds/maxTurns/thinkingLevel） | ✅ 基本对应 |
| **内置 8 种预设 Role** | Architect/PM/ProductManager/Engineer/QaEngineer/Searcher... | `lib/team/library.ts` + `templates.ts`（通用调研/开发/文档/验收模板）+ solver 模板 | ✅ 有模板角色库 |
| **`_watch()` 订阅上游产出（发布-订阅）** | 角色 watch 事件流 | `Transition.trigger.event`（completed/failed/...）+ `resolveRoute` 基于产出路由 | ✅ 等价（更显式） |
| **`set_actions()` 绑定动作** | 角色执行动作 | `AgentDef.toolNames` + `customTools`（team_handoff/team_create_task/team_record_decision） | ✅ |
| **`publish_message()` 环境消息池** | 共享 Environment 广播 | 群聊消息流（user/agent/system/handoff）+ `context.ts` 黑板注入 | ✅ |
| **Economic（经济：价值/预算记账）** | token 记账、投资额 | `ExecutionStats`（input/output/cache/cost/tokens）+ `TeamRun.stats.tokensUsed` | ◐ 有成本统计，无「投资额/预算上限」概念 |
| **`add_human` 人类角色入队** | 协作中加入人类 | `steer` API（`/steer`）+ `pendingApproval` 审批闸门（human-in-loop） | ✅ 等价的 human-in-loop |
| **`n_round` 指定迭代轮次** | 固定多轮迭代 | `maxHops`+`maxReworkRounds`（熔断防循环） | ✅ 更强（不再局限固定轮次） |

> **MetaGPT 小结**：MetaGPTTest 本质是一份**教学示例**（B 站视频配套 + python 入门脚本），核心是帮人理解 SOP/角色/环境。
> Pi 的 `lib/team` 在编排建模、可视化、熔断、结构化裁决上均已超越。**无明显 MetaGPT 独有且 Pi 缺失的能力**。

---

## 二、OpenHarness 能力对照（成熟 Harness：工具/技能/权限/记忆/多 agent）

### 2.1 工具与技能生态

| OpenHarness 能力 | 说明 | Pi Studio 现状 | 判定 |
|---|---|---|---|
| **44+ 内置 tools** | File/Shell/Search/Web/MCP（`tools/*.py`） | pi 原生工具集（read/bash/grep/edit/write/web-search...）+ `customTools`（团队控制） | ✅ 工具集丰富度相当 |
| **skill 按需加载（`.md`，anthropics 兼容）** | `skills/loader.py` | **已有 skill 体系**：`AgentDef.skillIds` 复用 pi-studio skills + `.agents/skills/*` | ✅ 已实现（本会话即用 browser-control/sheet-edit 等） |
| **plugin 插件生态** | `plugins/installer/loader` + `bundled` | pi 有 `../pi-*` 扩展（`examples/extensions`）？ | ◐ 需确认（pi 有 extension 机制，非专门团队插件） |
| **`tool_search_tool` 工具搜索/发现** | 自动检索可用工具 | pi 靠系统提示词内嵌工具列表 | ◐ 可考虑 |
| **并行工具执行** | `tools` 并行调度 | 角色内由 pi 会话编排 | ◐ |

### 2.2 权限与安全

| OpenHarness 能力 | 说明 | Pi Studio 现状 | 判定 |
|---|---|---|---|
| **多级权限模式**（`permissions/modes.py`） | 无权限/自动/强制询问 | pi 有项目信任机制（project trust）+ 工具白名单 `toolNames` | ✅ 有等价的受控白名单 |
| **路径规则 / 拒绝命令** | 可写路径限制、denied commands | pi `cwd` 限定 + 数据目录隔离；`AllowedPath` 类似物？ | ◐ 部分（工作区约束，无精细路径 ACL） |
| **PreToolUse / PostToolUse hooks** | 工具调用前后钩子 | executor 订阅 `tool_execution_start` 做进度转发（读取型） | ◐ 有事件钩子，无「拦截/阻断」语义的 pre-hook |
| **dry-run 安全预览** | 不执行工具预览将做动作 | pi 无 dry-run；工具实际执行 | ❌ 缺失 |
| **secret 扫描防护（写团队记忆时）** | `memory/team.py` 正则拦截 AKIA/key/token | pi 团队上下文黑板无 secret 扫描 | ❌ 缺失（安全加固项） |

### 2.3 多 Agent（Swarm）核心

| OpenHarness 能力 | 说明 | Pi Studio 现状 | 判定 |
|---|---|---|---|
| **subagent 生成 + team registry** | `swarm/registry.py` 子代理注册 | PiAgentExecutor 每角色启动独立 pi 会话 | ✅ 等价的每角色独立子进程会话 |
| **Git worktree 隔离**（`swarm/worktree.py`） | 每 agent 独立 worktree+分支+共享依赖符号链接 | `AgentDef.workspace` 注释「Phase 2 接 worktree」，**未实现** | ❌ **明确缺失（P2-1）** |
| **leader-worker 权限审批同步**（`swarm/permission_sync.py`） | worker 请求权限→leader 批准/驳回（pending→resolved） | `waiting_approval`+`approve/reject` API 是 **转换边审批**，方向「agent 产出→用户审批」，非「worker→leader 工具权限」 | ◐ 有审批闸门，但**非 agent 间工具权限审批** |
| **持久化 Team 生命周期**（`swarm/team_lifecycle.py`） | `~/.openharness/teams/<name>/team.json` 落盘 CRUD | team 以 `sessions/<id>.jsonl` + TeamDef meta 落盘 | ✅ 有持久化（Event Sourcing 更强） |
| **teammate 邮箱**（`swarm/mailbox.py`） | agent 间消息投递（文件异步队列） | 群聊消息流 + 上下文黑板注入，无「点对点邮箱」 | ◐ 黑板通信等价，无定向 mailbox |
| **共享团队记忆库 MEMORY.md**（`memory/team.py`） | 项目级 `team/MEMORY.md` 持久记忆 | **跨 run 记忆未实现**（`lib/team` 无 MEMORY/persist 引用） | ❌ **明确缺失（P2-2 跨 run 记忆）** |
| **Auto-Compaction** | 长会话自动压缩 | `executor.ts` 已启用 `compaction: { enabled: true }` + `recommendedCompactionForWindow` | ✅ 已实现 |
| **后台/长时任务**（`tasks/*.py` + task tools） | task_create/get/list/output/stop | TeamTask（TASK-xxx）+ 任务黑板 | ✅ 等价 |

### 2.4 渠道 / Provider / 可观测

| OpenHarness 能力 | 说明 | Pi Studio 现状 | 判定 |
|---|---|---|---|
| **CLI channels**（Feishu/Slack/Telegram/Discord/**DingTalk**/WhatsApp） | 接入 IM 触发 agent | pi 无 IM channel 接入 | ❌ 缺失（本地桌面工具，暂不需要） |
| **多 provider 兼容**（Claude/OpenAI/Copilot/Codex/Kimi/GLM/MiniMax...） | LLM 后端切换 | `lib/provider-listing.ts`（118 行）+ 模型目录/发现/测试 + `enabledModels` 作用域 | ✅ 已实现（且更细粒度：per-agent model） |
| **授权管理**（`auth/*` flows/storage） | provider 登录授权 | `provider-credential-store.ts` 凭据存储 | ✅ 已有凭据存储 |
| **执行回放 / 会话历史** | — | `AgentExecution.sessionPath`+`sessionFile`（每角色会话 jsonl 可回放/审计）+ `ExecutionCard` 角色卡 | ◐ 底层会话可回放，但 **完成 run 的逐角色执行分解 UI 不可回看**（`executionsOverview` 仅 running 渲染，见 leader-analysis §新增问题3） |
| **实时进度可视化**（thinking/tool） | — | `agent_progress` 团队事件 + ExecutionCard 进度 | ✅ 已实现（可见性修复完成） |

---

## 三、结论：Pi Studio 相对两参考项目的「缺陷与不足」（按优先级）

### P0（能力缺失，feature-gap）
1. **❌ 任务依赖 DAG 调度（P1-3）** —— `TeamTask.dependsOn` 已定义但未接入调度（`types.ts:242` 注释 Phase 2）。OpenHarness/MetaGPT 均有任务列表，无依赖图调度。
2. **❌ worktree 隔离（P2-1）** —— `AgentDef.workspace.mode: "isolated"` 仅注释，多角色并发写同一仓库时**无隔离**，易冲突。
3. **❌ 跨 run 共享团队记忆（P2-2）** —— OpenHarness 有 `team/MEMORY.md`，Pi 会话间不共享历史，长协作各 run 失忆。

### P1（安全/健壮性）
4. **❌ secret 扫描防护** —— OpenHarness 写团队记忆前正则拦截 key/token/AWS；Pi 黑板无防护，agent 产出可能把密钥写进共享上下文。
5. **❌ dry-run 安全预览** —— 无法在真实执行前预览"该角色将调哪些工具"。Pi 进度只能事后转发 `tool_execution_start`，无事前预览。
6. **◐ PreToolUse 拦截语义缺失** —— 仅有读取型事件钩子，无「阻断危险工具调用」的 pre-hook。

### P2（体验/可观测）
7. **❌ 完成 run 无法回看执行分解** —— 跑完后 `executionsOverview` 只剩一行，逐角色 token/产物/耗时不可查（leader-analysis 新增问题3，仍待修）。
8. **❌ IM channel 接入** —— 无 Feishu/DingTalk/Slack 渠道（若目标是纯本地桌面，可降级为非需求）。
9. **◐ agent 间定向 mailbox 缺失** —— 当前靠黑板广播，无点对点私信投递。
10. **❌ 经济/预算模型缺失** —— OpenHarness/MetaGPT 有投资额/预算概念，Pi 只有成本统计无预算上限熔断。

### 已覆盖项（对标确认，非缺陷）
- ✅ BPMN 可视化工作流（parallel/inclusive/merge 网关）远超 MetaGPT 线性 SOP。
- ✅ 实时进度可视化的 thinking/tool 转发（本轮已实现）对应 OpenHarness 可观测。
- ✅ Auto-Compaction、多 provider + per-agent model、skill 复用、持久化 Event Sourcing、审批闸门（human-in-loop）。
- ✅ 熔断机制（maxHops/maxRework）防 MetaGPT 式固定轮次空转。

---

## 四、给测试角色的核实清单（逐行取证项）

测试角色针对下列「❌/◐ 缺失」在源码逐行核实，防"口头有实现"：
1. `types.ts` lines ~24-25、~142、~242：确认 worktree/工作区隔离/DAG 仅为注释未接线。
2. `lib/team/` 全局 grep `MEMORY|persist|跨run|memory`：确认无跨 run 共享记忆实现。
3. `context.ts`：确认黑板注入无 secret 扫描。
4. `executor.ts` + `components/TeamChat.tsx` `executionsOverview`：确认只读型 `tool_execution_start` 转发，无 pre-hook 拦截；完成 run 分解 UI 缺失。
5. `app/api/teams/runs/[runId]/approve|reject`：确认审批是 **转换边审批**（agent 产出→用户），非 agent 间工具权限审批。