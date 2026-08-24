# Agent Team Runtime 设计方案（项目组会话 / Multi-Agent Workflow Runtime）

> 状态：设计稿 v5.1（2026-08-23）—— 架构基线定稿；
> Phase 1A（Runtime MVP）✅ 完成、Phase 1B（UI）✅ 完成、Phase 1C 前置（react-flow 工作流编辑器 + 团队模板库多模板可视化编辑）✅ 完成。
> 完成状态见 §10 实施状态表；实现偏差与踩坑见 §13 实录。
> 决策背景：见长期记忆「多Agent群聊功能方案调研」。不抛弃 pi-studio、不抄 frakio 代码。
> v5 变更（吸收两轮架构评审）：
> 1. **Event Sourcing 硬约束**：events.jsonl = 唯一事实来源（append-only），
>    TeamState/TeamChat/Tasks/Executions/Artifacts 全部是投影（Projection），
>    snapshot 只做性能优化。**禁止任何"增量更新状态文件"的第二状态源。**
> 2. **Task 权限与依赖**：`createdBy` + `dependsOn`；Agent 只能通过受控工具
>    （team_handoff / team_create_task / team_complete_task / team_add_artifact / team_record_decision）
>    影响状态，Runtime validate 后才产生 Event。
> 3. **路由判定顺序定死**：explicit handoff → keyword → always → LLM judge（LLM 只做最后决策器，一次调用）。
> 4. **ArtifactRef 带 `producedByExecutionId`**，建立 Artifact→Execution→Agent 链路。
> 5. **Transition.priority 规则 + RunStatusReason + Decision[] + event.sequence + routingPolicy 预留**。

---

## 1. 目标与场景

### 1.1 用户视角（最终形态）

1. **项目组 = 会话的升级形态**（Team-backed Session）。新建会话可选「创建为项目组」；
   已有会话可「转为项目组」（历史导入）；可「转回普通会话」（只切 UI 模式，Team 数据保留）。
2. **角色完全可配置**。角色库（内置 + 自建），每角色可配：职责提示词、模型、工具、
   技能（skillIds 复用 pi-studio 体系）、工作空间、轮次/超时限制。
3. **执行时机与条件可配置**。Workflow 图：Node=角色，Edge=Transition
   （触发事件 + 条件：keyword / LLM / always + priority）。
4. **共享上下文**。角色执行时注入**结构化工作上下文**（任务 + 进度 + 最近消息 + 产物），
   而非聊天全文。
5. **布置任务** → 入口角色开始 → 按 Workflow 路由 / 自主 handoff 接力 →
   群聊实时显示 → 可查看每角色每次执行的原始会话详情。

### 1.2 示例

```
项目组「库存差异分析」（由已有会话转换，历史已导入）
Workflow：
  组长 ──always──► 产品 ──always──► 开发 ──always──► 测试
  测试 ──keyword[问题/失败/bug]──► 开发   （返工边，reworkEdges 显式声明）
  测试 ──keyword[通过/完成/没问题]──► 组长  （总结边）
```

### 1.3 范围

- **Phase 1A（Runtime MVP）**：数据模型 + EventStore + 生命周期 + 受控工具 +
  TeamRuntime（RunManager/WorkflowEngine/ContextEngine/AgentExecutor）+ API/SSE +
  真实 Agent E2E（组长→产品→开发→测试→返工→组长）。
- **Phase 1B（UI）**：Sidebar 混排 + 新建/转换对话框 + TeamChat + TeamSettings 表单页。
- **Phase 1C（Workflow Canvas）**：只读状态图 → 可视化编辑。
- **Phase 2**：worktree 隔离、人工审批闸门、并行触发（Task dependsOn 启用）、执行回放 UI。
- **Phase 3**：多级子项目组、角色跨 run 记忆、模板市场、session 保留策略细化。

### 1.4 核心设计原则

1. **Event Sourcing**：一切状态变化 = 一个 Event，append 到 events.jsonl。投影只读派生。
2. **分层不混**：TeamChat（可读记录）/ TeamState（机器状态）/ Workflow（可执行路由）/
   Artifacts（真实产物）四层分离。
3. **一个角色执行 = 一个 pi 会话**（复用 `startRpcSession`）。
4. **Artifact First**：交接传 ArtifactRef（含 executionId 溯源），角色 `read` 验证。
5. **受控状态修改**：Agent 通过受控工具影响状态，Runtime validate 后产生 Event。
6. **不特判任何角色**；组长只是 `entryAgentId`。`__entry__` 只存在于 UI 渲染。
7. **确定性优先**：strict/hybrid 默认；LLM 判定只做最后决策器，成本可控。

---

## 2. 核心概念分层

```
┌──────────────────────────────────────────────────────────────┐
│ TeamChat      人类可读的协作记录（群聊消息流）                  │
│ TeamState     机器可读的工作状态（进行到哪、决策、阻塞）         │
│ Workflow      机器可执行的路由（Node=Agent, Edge=Transition）  │
│ Artifacts     真实工作产物（文件/commit/报告，带 executionId）  │
└──────────────────────────────────────────────────────────────┘
        │ 全部是投影（Projection）
        ▼
┌──────────────────────────────────────────────────────────────┐
│ Event Log（events.jsonl，append-only，唯一事实来源）           │
│   + snapshot.json（eventSequence + projections，性能优化）     │
│   + EventReducer（replay → 重建全部投影）                      │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. 数据模型（`lib/team/types.ts`）

### 3.1 角色（AgentDef）与角色库

```ts
export type RoutingPolicy = "inherit" | "strict" | "hybrid" | "autonomous";

export interface AgentDef {
  id: string;                 // 组内唯一
  name: string;
  emoji?: string;
  role: string;               // 职责描述（展示 + 注入 prompt 开头）
  model: string;
  systemPrompt: string;
  toolNames: string[];
  skillIds?: string[];        // 复用 pi-studio skill 体系
  workspace?: {
    mode: "team" | "isolated";  // 默认 "team"；Phase 2 接 worktree
    cwd?: string;
  };
  routingPolicy?: RoutingPolicy;      // 默认 "inherit"（跟随团队 defaultRoutingMode）
  handoffPolicy?: {
    allowedTargets?: string[];        // 白名单（空 = 受 Workflow 约束）
    allowSelfHandoff?: boolean;       // 默认 false
  };
  contextPolicy?: {
    scope: "structured" | "summary" | "recent";  // 覆盖团队默认
    recentCount?: number;
  };
  maxTurns?: number;          // 默认 20
  maxOutputChars?: number;    // 默认 4000
  timeoutMs?: number;         // 默认继承 maxRunMinutes
}

export interface AgentLibraryItem {
  id: string;
  name: string;
  emoji?: string;
  role: string;
  model: string;
  systemPrompt: string;
  toolNames: string[];
  skillIds?: string[];
  builtin?: boolean;
  createdAt: number;
  updatedAt: number;
}
```

### 3.2 Workflow：Transition + Condition

```ts
export interface Transition {
  id: string;
  from: string;               // 源 Agent id
  to: string;                 // 目标 Agent id
  priority: number;           // 默认 0；同 from 多候选时 DESC 取第一个
  trigger: {
    event: "completed" | "failed" | "timeout" | "handoff";  // 默认 completed
    condition?: Condition;
  };
  enabled?: boolean;
}

export type ConditionMode = "keyword" | "llm" | "always";

export interface Condition {
  mode: ConditionMode;
  keywords?: string[];        // keyword：产出含任一词即触发
  rejectKeywords?: string[];  // 含任一词强制不触发（优先级高于 keywords）
  conditionText?: string;     // llm：自然语言条件（最后决策器，一次调用判候选集）
}
```

**路由判定顺序（固定，见 §7.3）**：

```
1. explicit handoff（team_handoff 工具，Agent 明确意图）  [hybrid/autonomous；strict 忽略]
2. Transition.keyword    （便宜，先试）
3. Transition.always     （无条件，默认 priority=0 最低档）
4. Transition.llm        （最后决策器：对未决候选集一次性 LLM 判定，最多一次调用）
```

**Workflow 静态校验（`lib/team/validate.ts`，保存前调用）**：

```ts
interface WorkflowValidationResult {
  valid: boolean;
  errors: ValidationIssue[];    // 阻断保存
  warnings: ValidationIssue[];  // 仅提示
}
interface ValidationIssue { code: string; message: string; transitionId?: string; agentId?: string; }
```

| 级别 | 检查项 |
|---|---|
| error | Transition 指向不存在的 Agent；Entry Agent 不存在；条件配置非法（keyword 无关键词 / llm 无文本 / always 混配）；strict 模式存在无出口节点；Self-loop（from===to，除非显式允许） |
| warning | Agent 永远不可达（无 incoming）；可能形成循环（可达环）；多条 Transition 优先级重叠；Agent 从未作为任何边的目标；没有任何指向 entryAgentId 的路径 |

### 3.3 项目组（TeamDef）

```ts
export type RoutingMode = "strict" | "hybrid" | "autonomous";
export type ContextScope = "structured" | "summary" | "recent";
export type SessionRetention = "full" | "summary" | "delete_after_days";  // Phase 1 默认 full

export interface TeamDef {
  sessionId: string;          // Team-backed Session 的宿主 pi 会话 id
  name: string;
  cwd: string;
  entryAgentId: string;
  agents: AgentDef[];
  transitions: Transition[];
  reworkEdges?: Array<{ from: string; to: string }>;   // 显式声明返工边（v4 遗留，保留）
  defaultRoutingMode: RoutingMode;   // 默认 "hybrid"；Agent.routingPolicy 可覆盖（Phase 2）
  maxHops: number;            // 默认 30（防任意循环）
  maxReworkRounds: number;    // 默认 3（只统计返工边）
  maxRunMinutes: number;      // 默认 30
  contextScope: ContextScope; // 默认 "structured"
  recentCount?: number;       // scope=recent 时（默认 20）
  sessionRetention?: SessionRetention;   // Phase 1 不实现，仅预留
  createdAt: number;
  updatedAt: number;
}
```

### 3.4 Run + AgentExecution + TeamTask

```ts
export type TeamRunStatus = "pending" | "running" | "waiting_handoff"
  | "completed" | "failed" | "cancelled";

export type RunStopCode =
  | "completed"
  | "max_hops" | "max_rework" | "timeout"
  | "agent_failed" | "workflow_dead_end" | "user_cancelled";

export interface TeamRun {
  id: string;
  teamId: string;             // = sessionId
  status: TeamRunStatus;
  task: string;
  statusReason?: {            // UI 直接展示停止原因（调试 Multi-Agent 关键）
    code: RunStopCode;
    message: string;
  };
  stats: {
    hopCount: number;         // 每次角色执行 +1
    reworkCount: number;      // 仅返工边命中 +1
    agentExecutions: number;
    tokensUsed: number;
    durationMs: number;
  };
  createdAt: number;
  updatedAt: number;
  // 不含 messages/tasks/state —— 全部为投影（§4）
}

export interface AgentExecution {
  id: string;
  runId: string;
  agentId: string;
  sequence: number;           // 该角色在本 run 中的第几次执行
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  sessionId: string;          // pi 会话 id（回放/审计；retention 策略基于此）
  sessionPath?: string;
  inputTokens?: number;
  outputTokens?: number;
  outputMessageId?: string;   // 群聊里对应的 agent 消息
  handoffTo?: string;
  taskIds?: string[];         // 本次执行关联的 Task
  failureReason?: string;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface TeamTask {
  id: string;                 // "TASK-001"
  runId: string;
  createdBy: string;          // "runtime" | "user" | agentId（谁创建：Runtime/用户 UI/Agent 受控工具）
  title: string;
  description: string;
  assignedAgentId: string;
  status: TaskStatus;
  parentTaskId?: string;
  dependsOn?: string[];       // Phase 1 仅预留字段不启用；Phase 2 并行时使用
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
```

### 3.5 TeamState / Decision / TeamMessage / ArtifactRef / HandoffPayload

```ts
/** 机器可读状态 —— 投影，由 EventReducer 派生，禁止运行时直接改写 */
export interface TeamState {
  goal: string;
  phase?: string;             // "planning"|"implementation"|"verification"|"summary"
  decisions: Decision[];
  artifacts: ArtifactRef[];
  completedTasks: string[];
  activeTasks: string[];
  blockers: string[];
  lastHandoff?: { from: string; to: string; reason: string; executionId: string };
}

export interface Decision {
  id: string;
  content: string;
  madeBy: string;             // agentId | "user" | "runtime"
  createdAt: number;
  relatedTaskId?: string;
}

export type TeamMessageKind = "user" | "agent" | "system" | "handoff" | "imported";

export interface TeamMessage {
  id: string;
  kind: TeamMessageKind;
  executionId?: string;       // agent 消息关联的 AgentExecution（溯源）
  agentId?: string;
  role?: string;
  content: string;
  artifacts?: ArtifactRef[];
  createdAt: number;
}

export interface ArtifactRef {
  id: string;
  path: string;
  type: "file" | "directory" | "url" | "commit";
  description?: string;
  createdBy: string;          // agentId
  createdAt: number;
  producedByExecutionId: string;   // ★ 哪次执行产生（QA 明确测试的是开发 #2 的产物）
  version?: string;           // 可选：同 path 多版本（developer #1 / #2 / #3）
}

export interface HandoffPayload {
  task?: string;
  summary?: string;
  artifacts?: ArtifactRef[];
  decisions?: Decision[];
  blockers?: string[];
}
```

---

## 4. 事件模型与投影（Event Sourcing 定稿）

### 4.1 事件类型（唯一事实来源）

```ts
// 每个事件必带：sequence（单调递增，不依赖时间戳）+ timestamp + type
type TeamEvent =
  | { type: "run_started";            sequence: number; timestamp: number; runId: string; task: string; entryAgentId: string }
  | { type: "task_created";           sequence: number; timestamp: number; task: TeamTask }
  | { type: "task_completed";         sequence: number; timestamp: number; taskId: string }
  | { type: "task_failed";            sequence: number; timestamp: number; taskId: string; reason?: string }
  | { type: "execution_started";      sequence: number; timestamp: number; execution: AgentExecution }
  | { type: "message_created";        sequence: number; timestamp: number; message: TeamMessage }
  | { type: "artifact_produced";      sequence: number; timestamp: number; artifact: ArtifactRef }
  | { type: "decision_recorded";      sequence: number; timestamp: number; decision: Decision }
  | { type: "handoff_requested";      sequence: number; timestamp: number; from: string; to: string; kind: "transition" | "tool"; transitionId?: string; reason?: string }
  | { type: "execution_completed";    sequence: number; timestamp: number; executionId: string; status: "completed" | "failed" | "cancelled"; handoffTo?: string; failureReason?: string }
  | { type: "steer";                  sequence: number; timestamp: number; agentId?: string; content: string }
  | { type: "run_completed";          sequence: number; timestamp: number; statusReason: { code: RunStopCode; message: string } }
  | { type: "run_failed";             sequence: number; timestamp: number; statusReason: { code: RunStopCode; message: string } }
  | { type: "run_cancelled";          sequence: number; timestamp: number; statusReason: { code: RunStopCode; message: string } };
```

### 4.2 投影（Projection）

```ts
interface Projections {
  state: TeamState;
  messages: TeamMessage[];
  tasks: TeamTask[];
  executions: AgentExecution[];
  artifacts: ArtifactRef[];
}

/** 纯函数：events → projections（replay 用） */
function reduce(events: TeamEvent[]): Projections;

/** 性能优化：周期性落盘的快照 */
interface TeamSnapshot {
  eventSequence: number;      // 快照包含到的最后 sequence
  projections: Projections;
}
```

### 4.3 恢复与回放流程

```
启动/打开 run：
  snapshot.json（存在）→ 载入 projections
  events.jsonl 中 sequence > snapshot.eventSequence 的事件 → reduce 增量重放
  → 最新 projections（内存）

SSE 新订阅者：
  先发 projections 快照（或 events 全量）
  客户端带 Last-Event-ID（= sequence）→ 重放 > 该 sequence 的 events → 实时增量

崩溃恢复：
  events.jsonl 是 append-only 唯一事实来源，永不丢
  snapshot 每 N 事件（如 50）落盘一次，纯优化
```

**硬规则**：
- **禁止**运行时直接改写 `state.json` / `meta.json` / 任何投影文件。
- 一切变更先写 events.jsonl（append），投影从内存 reduce 派生；
  snapshot 只是序列化当前投影的缓存。
- 事件写入失败 → 该操作视为未发生（先 Event 后生效，无第二状态源）。

---

## 5. 存储布局

```
<数据目录>/.internal/teams/
├── index.json                # sessionId → teamId 映射
├── library/                  # 角色库（builtin.json / user-<uuid>.json）
└── <sessionId>/
    ├── team.json             # TeamDef（静态配置，非事件源）
    ├── runs/
    │   └── <runId>/
    │       ├── events.jsonl  # ★ append-only 事件流（唯一事实来源）
    │       └── snapshot.json # 投影快照（性能优化，可随时删除重建）
    └── sessions/             # 角色执行 pi 会话（.jsonl）
        └── <runId>-<agentId>-<seq>.jsonl
```

- `team.json` 是**静态配置**（用户编辑，非事件流）——配置变更本身可记一条
  `config_updated` 事件（可选，Phase 2）。
- events.jsonl 单写者（Runtime 内串行 append + fsync）。

---

## 6. 会话 ↔ 项目组生命周期（Team-backed Session）

> **定位**：项目组 = Pi Session 的 Team-backed 形态。Pi Session 负责身份/生命周期/
> Sidebar；TeamRuntime 负责群聊/Workflow/Agent 执行。关联通过 index.json。

### 6.1 新建（创建即项目组）

```
POST /api/teams  { cwd, templateId?, name? }
1. sessionId = SessionManager.create(cwd).getSessionId()
2. 写 team.json（模板实例化 or 空团队）
3. 更新 index.json + invalidateSessionListCache()
```

### 6.2 转换（已有会话 → 项目组）

```
POST /api/teams/convert  { sessionId, templateId?, name? }
1. 校验会话存在且未是项目组
2. SessionManager.open().getBranch() 读历史 entries
3. 历史导入为初始事件（写 events.jsonl）：
   - user 消息 → message_created{ kind:"user" }
   - assistant 消息 → message_created{ kind:"imported", agentId:"__legacy__", role:"原会话" }
   - 工具调用/结果 → 剔除
   - 前置 message_created{ kind:"system", content:"以下为转换前的会话历史" }
4. 写 team.json + index.json + invalidateSessionListCache()
```

### 6.3 转回普通会话（方案 A：只切 UI 模式）

- `PATCH /api/teams/:sessionId { uiMode: "chat" }` → sidebar 恢复普通会话图标。
- Team 数据（team.json / runs / events）保留，随时可再转回。

### 6.4 删除

- 复用现有会话删除 API 扩展 `?team=1`：删宿主会话 + `<sessionId>/` 目录 + index 条目。

---

## 7. 运行时设计（`lib/team/runtime.ts`）

### 7.1 分层

```
                    TeamRuntime
                         │
        ┌────────────────┼────────────────┐
        │                │                │
     RunManager      WorkflowEngine    ContextEngine
   （run 生命周期）  （路由判定）        （上下文构建）
        │                │                │
        └────────────┬───┴────────────────┘
                     │
                AgentExecutor
                     │
              startRpcSession()
                     │
               Pi Agent Runtime
```

```
EventStore（append + replay）  ←—— 所有模块只通过它落状态
ProjectionStore（reduce + snapshot）
TeamStore / AgentLibrary
```

### 7.2 受控工具集（Agent 影响状态的唯一途径）

| 工具 | 作用 | 校验 |
|---|---|---|
| `team_handoff` | 交接（唯一自主路由协议） | 目标存在、非 self-loop、handoffPolicy 白名单 |
| `team_create_task` | 创建子任务 | 目标角色存在、title 非空 |
| `team_complete_task` | 完成任务 | taskId 存在且属于本 run |
| `team_add_artifact` | 声明产物 | path 存在（或显式 url/commit）、必填 producedByExecutionId |
| `team_record_decision` | 记录决策 | content 非空 |

- 工具结果被拦截 → Runtime validate → **产生 Event** → Reducer 更新投影。
- **Agent 输出文本绝不直接改状态**（防"我已经完成了所有任务"污染 state.phase）。
- 工具注入方式：`startRpcSession` 的 `customTools`（已有 dshTools 先例）。

### 7.3 路由判定（WorkflowEngine，顺序固定）

```ts
class WorkflowEngine {
  /** 一次路由决策，最多一次 LLM 调用 */
  async resolveRoute(execution: AgentExecution, result: ExecutionResult): Promise<Route | null> {
    const agent = this.team.agents.find(a => a.id === execution.agentId)!;
    const mode = agent.routingPolicy !== "inherit"
      ? agent.routingPolicy
      : this.team.defaultRoutingMode;

    // 1) explicit handoff（Agent 明确意图，最可靠）—— strict 模式忽略
    if (mode !== "strict" && result.handoffTool) {
      this.validateHandoff(agent, result.handoffTool);   // 白名单 / self-loop / 目标存在
      return { kind: "tool", from: agent.id, to: result.handoffTool.to, payload: result.handoffTool };
    }

    // 2) 候选 Transition：from 匹配 + event 匹配
    const candidates = this.team.transitions
      .filter(t => t.enabled !== false && t.from === agent.id
        && (t.trigger.event === execution.status || t.trigger.event === "any"))
      .sort((a, b) => b.priority - a.priority);

    // 3) keyword / always（便宜，先试）—— priority DESC 取第一个命中
    for (const t of candidates) {
      if (t.trigger.condition?.mode === "keyword" || t.trigger.condition?.mode === "always") {
        if (await judgeCheap(t.trigger.condition, result.output)) {
          return { kind: "transition", from: agent.id, to: t.to, transitionId: t.id };
        }
      }
    }

    // 4) LLM judge（最后决策器）：对剩余 llm 候选集一次性判定，最多一次调用
    const llmCandidates = candidates.filter(t => t.trigger.condition?.mode === "llm");
    if (llmCandidates.length > 0 && this.llmJudgeEnabled) {
      const chosen = await judgeLlmOnce(llmCandidates, result.output);   // 一次调用，返回其一或 null
      if (chosen) return { kind: "transition", from: agent.id, to: chosen.to, transitionId: chosen.id };
    }

    return null;
  }
}
```

### 7.4 执行循环（RunManager）

```ts
class RunManager {
  async execute(run: TeamRun) {
    let agentId = this.team.entryAgentId;               // ★ Runtime 不用 __entry__ 节点
    await this.append("run_started", { runId: run.id, task: run.task, entryAgentId: agentId });

    while (true) {
      // —— 保险丝 ——
      if (run.stats.hopCount >= this.team.maxHops) return this.finish("max_hops", "达到最大 Hop 数");
      if (run.stats.reworkCount > this.team.maxReworkRounds) return this.finish("max_rework", "返工超过上限");
      if (elapsed > this.team.maxRunMinutes * 60_000) return this.finish("timeout", "运行超时");

      // —— 执行一个角色 ——
      const exec = await this.agentExecutor.run(agentId);   // 内部 startRpcSession + events
      run.stats.hopCount++;
      run.stats.agentExecutions++;

      // —— 路由 ——
      const route = await this.workflowEngine.resolveRoute(exec, exec.result);
      if (!route) {
        if (this.effectiveMode(agentId) === "strict") {
          return this.finish("workflow_dead_end", `${agentId} 无匹配 Transition（strict）`);
        }
        if (agentId === this.team.entryAgentId) return this.finish("completed", "入口角色收尾完成");
        agentId = this.team.entryAgentId;                 // hybrid 兜底回入口
        this.bumpRework(agentId, route);
        continue;
      }

      await this.append("handoff_requested", { from: route.from, to: route.to, ... });
      if (this.isReworkEdge(route)) run.stats.reworkCount++;
      agentId = route.to;
    }
  }

  /** 返工边判定：reworkEdges 显式配置优先；兜底启发式（验证类角色→非 entry） */
  private isReworkEdge(route: Route): boolean {
    const explicit = this.team.reworkEdges?.some(e => e.from === route.from && e.to === route.to);
    if (explicit !== undefined) return explicit;
    const from = this.team.agents.find(a => a.id === route.from);
    return from !== undefined && /测试|QA|审|验证|质检/i.test(from.role) && route.to !== this.team.entryAgentId;
  }

  private finish(code: RunStopCode, message: string) {
    const evType = code === "completed" ? "run_completed" : code === "user_cancelled" ? "run_cancelled" : "run_failed";
    this.append(evType, { statusReason: { code, message } });
  }
}
```

### 7.5 上下文构建（ContextEngine，三层结构）

```
【任务】run.task + state.phase + activeTasks/completedTasks
【当前进度】state.lastHandoff + decisions + blockers（每角色一句话摘要）
【最近消息】contextScope 控制：
   structured = 任务 + 进度 + 最近全部 user/agent/handoff 消息 + 产物
   summary    = 任务 + 进度 + 产物（省 token）
   recent     = 任务 + 最近 N 条 + 产物
【产物】state.artifacts 全部 ArtifactRef（角色 read 自行验证）
```

- 产物永远以 ArtifactRef 给出，不拼文件内容。
- `contextScope: "structured"`（默认）——**不是**"全部历史全文"（命名修正：v4 的 `full` 误导，已改）。

### 7.6 防跑飞（四保险互不干扰）

| 保险 | 默认 | 防什么 |
|---|---|---|
| `maxTurns`（角色） | 20 | 单角色单次执行内跑飞 |
| `maxHops`（团队） | 30 | 任意循环 A→B→C→A |
| `maxReworkRounds`（团队） | 3 | 返工无限循环 |
| `maxRunMinutes`（团队） | 30 | 整体挂死 |

---

## 8. API 路由（`app/api/teams/**`）

```
# 生命周期
POST   /api/teams                  新建（{ cwd, templateId?, name? }）
POST   /api/teams/convert          转项目组（{ sessionId, templateId?, name? }）
GET    /api/teams                  列出（含会话元信息）
GET    /api/teams/:sessionId       详情（agents + transitions + routingMode + 当前投影）
PATCH  /api/teams/:sessionId       更新（含 uiMode 切回普通会话）
DELETE /api/teams/:sessionId       删除（连同宿主会话）

# 角色库
GET/POST /api/teams/agents/library
PATCH/DELETE /api/teams/agents/library/:id

# 角色 / Workflow 边
POST/PATCH/DELETE /api/teams/:sessionId/agents[/:agentId]
POST/PATCH/DELETE /api/teams/:sessionId/transitions[/:transitionId]
POST   /api/teams/:sessionId/validate   # 静态校验（保存前）

# 运行
POST   /api/teams/:sessionId/runs      发布任务（{ task }）
GET    /api/teams/:sessionId/runs      运行历史
GET    /api/teams/runs/:runId          详情（meta + 投影：state/messages/tasks/executions/artifacts）
GET    /api/teams/runs/:runId/events   SSE（先投影快照，再 replay > Last-Event-ID，再实时增量）
POST   /api/teams/runs/:runId/cancel   取消（事件 run_cancelled{ user_cancelled }）
POST   /api/teams/runs/:runId/steer    人工介入（@角色 发送，message_created + 注入当前会话）
```

SSE 协议：`Last-Event-ID` = 事件 sequence；断线重连 = replay `sequence > Last-Event-ID`。

---

## 9. 前端 UI

### 9.1 Sidebar（混排）

- `SessionInfo` 附加可选 `teamId`/`teamName`（session-reader 查 index.json）。
- 项目组条目 👥 图标混排；新建对话框「创建为项目组」；
  会话右键/顶部「转为项目组」（显示将导入 N 条历史）/「项目组设置」/「转回会话」。

### 9.2 Phase 1B 组件

```
components/
├── TeamCreateDialog.tsx
├── TeamChat.tsx               # 群聊 + 输入框（@角色 选择器做 steer）+ 状态条（含 statusReason）
├── TeamMessageBubble.tsx      # user/agent/system/handoff/imported 样式 + 产物链接
├── TeamWorkflowView.tsx       # 只读状态图（Phase 1B 列表式 → 1C 图式；START 节点仅 UI 渲染）
├── TeamSettings.tsx           # 表单：Agents / Transitions / Context / Limits / RoutingMode
├── AgentLibraryPanel.tsx
└── TeamRunHistory.tsx         # 运行历史 + statusReason 展示 + 执行明细
hooks/
└── useTeamRun.ts              # SSE（Last-Event-ID 重连）+ 投影增量
```

- 角色消息气泡可展开「查看执行详情」：该次 AgentExecution 的原始 pi 会话回放。
- 状态条：当前执行角色 + 序列号（开发 #2）+ hopCount/reworkCount + 停止原因。

---

## 10. 实施计划

### 实施状态总览（2026-08-23）

| Phase | 状态 | 说明 |
|---|---|---|
| 1A Runtime MVP | ✅ 完成 | 步骤 1-9 全部落地 + 8 个测试文件（store/lifecycle/tools/engine/runtime/e2e/compaction-*） |
| 1B UI | ✅ 完成（2026-08-23） | Sidebar 新建下拉（会话/项目组）、TeamChat、TeamSettings（角色/工作流流程图/团队参数）、TeamFlowCanvas、ModelSelect、全局角色库（设置→角色库，内置可编辑覆盖+恢复默认）、指定起始角色、i18n 全量 |
| 1C Workflow Canvas | ⬜ 未开始 | 详细设计见下 |
| 2 深度功能 | ⬜ 未开始 | 详细设计见下 |
| 3 扩展 | ⬜ 未开始 | 详细设计见下 |

### Phase 1A —— Runtime MVP ✅

| 步骤 | 内容 | 文件 | 状态 |
|---|---|---|---|
| 1 | 数据模型 + 事件类型 + 投影 reduce | `lib/team/types.ts` | ✅ |
| 2 | EventStore（append/fsync/replay/snapshot）+ TeamStore + 角色库 | `lib/team/store.ts` `library.ts` | ✅ |
| 3 | 生命周期（新建/转换/转回/删除，历史导入为事件） | `lib/team/lifecycle.ts`、`app/api/teams/convert` | ✅ |
| 4 | 受控工具集（handoff/create_task/complete_task/add_artifact/record_decision） | `lib/team/tools.ts` | ✅ |
| 5 | WorkflowEngine（路由判定顺序 + 校验 validate.ts） | `lib/team/engine.ts` `validate.ts` | ✅ |
| 6 | ContextEngine（三层结构化上下文）+ AgentExecutor | `lib/team/context.ts` `executor.ts` | ✅ |
| 7 | RunManager（执行循环 + 保险丝 + statusReason） | `lib/team/runtime.ts` | ✅ |
| 8 | API：runs/SSE/cancel/steer | `app/api/teams/**` | ✅ |
| 9 | **真实 Agent E2E**：真实 PiAgentExecutor 跑「组长→文档→组长收尾」；4 角色全链路由 `runtime.test.mjs` mock 覆盖（理由见 §13） | `lib/team/e2e.test.mjs` | ✅ |

### Phase 1B —— UI 🟡（剩 4 组件）

| 步骤 | 内容 | 状态 |
|---|---|---|
| 10 | Sidebar 混排 + 新建/转换对话框 + session-reader 附加 teamId | ✅ |
| 11 | TeamChat + steer 输入 + 消息气泡（气泡样式内联在 TeamChat，未抽 TeamMessageBubble） | ✅ |
| 12 | TeamSettings 表单页 + RunHistory + i18n + 测试 | ✅ 全部完成：角色表单（EmojiPicker/ToolPicker 点击弹出选择、thinkingLevel）；工作流（@xyflow/react WorkflowEditor 直接拖拽编辑 + 边列表联动）；全局角色库；指定起始角色；TeamChat 输入 @角色/@文件//skill + 点击重命名 + 角色点击弹编辑；团队模板库（多模板：内置只读 + 用户模板 CRUD + TeamTemplateEditor 可视化编辑 + 用户模板建团队）；i18n zh/en 各 105 key |

### Phase 1C —— Workflow Canvas（只读 → 编辑）设计

> **已落地（2026-08-23）**：工作流可视化编辑器 `WorkflowEditor.tsx`（基于 **@xyflow/react 12**）——拖拽节点移动、右侧把手拖线建边、双击节点编辑角色、双击边删除、边点击联动列表；TeamSettings 工作流 Tab 默认直接可编辑（无开关）。只读图 TeamFlowCanvas 保留用于模板预览。

**目标**：把 §3.2 的 Workflow 可视化。1B 先用列表式（TeamWorkflowView 表格），1C 升级为图式。

**技术选型（推荐自绘，零新依赖）**：

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. 自绘 SVG（分层 DAG 布局算法 ~200 行） | 零依赖、体积可控、样式可深度定制 | 拖拽连线交互要手写 | ✅ 推荐 |
| B. react-flow | 交互组件现成（拖拽/缩放/连线） | +100KB 依赖；样式要与 pi-studio 主题对齐 | 备选，体积敏感不引 |

**只读状态图（1C 第一步）**：
- 节点 = Agent（emoji + 名称 + 模型）；`__end__` 渲染为终止圆点（非 Agent，见 §13）；入口节点带 ▶ 标记。
- 边 = Transition（箭头 + priority + condition 徽标：keyword🔑 / always∞ / llm🤖 / handoff📮）。
- 当前执行高亮：正在运行的 Agent 节点呼吸动画 + 已完成边变色（读 `GET /api/teams/runs/:runId` 的 executions 投影）。
- 布局：分层拓扑排序（同层同列），自绘 SVG + HTML 节点（`foreignObject` 或绝对定位 div）。

**可视化编辑（1C 第二步）**：
- 编辑态 = 本地 draft state（**不直接落事件流**；配置变更落 `config_updated` 事件属 Phase 2）。
- 操作：从 AgentLibraryPanel 拖入节点 / 节点间拖线建 Transition / 双击边编辑 trigger+condition+priority / 节点侧栏编辑 AgentDef。
- 每次编辑后调 `POST /api/teams/:sessionId/validate`：error 红框阻断保存，warning 黄标提示；保存 = 批量 `POST/PATCH/DELETE .../agents` + `.../transitions`。
- 撤销/重做：draft 栈（本地，不占事件流）。

### Phase 2 —— 深度功能设计

**P2-1 worktree 隔离（`workspace.mode=isolated`）**
- 每次 AgentExecution 开工前创建独立 worktree（复用 pi-studio worktree 体系），`cwd` 指向 worktree。
- 执行完成后按 routingPolicy 决定合并时机：hybrid 自动合并（回主干前先 diff 校验）；strict/审批模式等人工确认（配合 P2-2）。
- 失败回滚：execution failed → worktree 丢弃（不 merge），可配 `onFailure: "discard" | "keep_for_inspection"`。
- 冲突：merge 冲突时挂起该 execution 为 `needs_merge`，SSE 通知人工解决（复用 pi-studio 冲突处理 UI）。
- 数据模型扩展：`AgentDef.workspace.cwd` 运行时解析为 worktree 路径；`AgentExecution` 增加 `worktreePath?`、`mergedAt?` 字段。

**P2-2 人工审批闸门（Approval Gate）**
- 配置：`Transition` 增加 `approval?: { mode: "require" | "optional"; note?: string }`；或 `TeamDef.approvals: Array<{ transitionId: string; note?: string }>`。
- 流程：命中审批边 → run 状态 `waiting_approval`（新增）→ 写 `approval_requested` 事件 → SSE 推送 → 用户批准/驳回 → `approval_granted` / `approval_rejected` 事件 → 路由继续或改走 reject 分支（可配 `onReject: { to?: string }`）。
- 事件扩展：`approval_requested` / `approval_granted` / `approval_rejected` 三种新事件（带 `transitionId` + `runId`），投影新增 `pendingApprovals: ApprovalRequest[]`。
- API：`POST /api/teams/runs/:runId/approvals/:transitionId { action: "grant" | "reject", note? }`。

**P2-3 并行触发（启用 `TeamTask.dependsOn`）**
- 调度改造：RunManager 从「单 agentId 串行循环」升级为「ready-set 调度」：execution 完成 → 按 Transition 解锁下游 → 并行执行所有 ready 节点（每节点独立 worktree，P2-1 前提）。
- 事件流增加分支概念：`AgentExecution.branchId`（同 run 内唯一），`execution_started` 可并发 append（EventStore 单写者仍串行，只是业务并发）。
- 汇总汇合：多分支汇聚到同一 Agent 时，需等全部上游 execution 完成（join 语义），ContextEngine 注入各分支产物摘要。
- 限制：`maxConcurrentExecutions`（默认 2）+ `maxParallelBranches`（默认 3）防资源打满。

**P2-4 routingPolicy Agent 级覆盖**：engine.ts `effectiveMode()` 已实现；补 UI（TeamSettings 每角色下拉）+ `TeamDef.routingPolicy` 继承说明。

**P2-5 执行回放 UI**：按事件流回放（进度条 + 每事件高亮 + 消息/状态同步滚动），复用 `useTeamRun` 的 reduce 逻辑做时间轴。

**P2-6 llm 判定模型独立配置**：`TeamDef.llmJudge = { provider: string; model: string }`（不走 Agent 模型）；未配置时 llm 条件永不命中（安全降级，engine.ts 已如此实现）。

### Phase 3 —— 扩展设计

**P3-1 多级子项目组**
- 子项目组 = 独立 `TeamDef`（独立 events.jsonl/投影），父 Workflow 增加「子组节点」：Transition.to 可为 `team:<teamId>`；父 run 的 handoff 到子组 = 启动子组 entryAgent 执行，子组 run_completed 作为父节点的完成事件。
- 数据模型：`Transition.to` 扩展为 `agentId | "team:<teamId>"`；`HandoffPayload` 增加 `parentRunId`。

**P3-2 角色跨 run 记忆**
- 原则不变（一切进事件流）：新增 `memory_note` 事件（`agentId` + `content`），投影出 `AgentMemory[agentId] = Array<{content, runId, createdAt}>`。
- ContextEngine 注入最近 N 条该角色历史记忆（可选 `AgentDef.memory: "none" | "team" | "agent"`，默认 none）。
- 存储：记忆随 events.jsonl 天然持久，无需新文件。

**P3-3 模板市场**
- `templates.ts` 内置模板 → 支持导出为独立 JSON（agents + transitions + 说明）→ 可 git 模板仓库安装（复用 skill 安装管线，含版本锁定）。
- API：`GET/POST /api/teams/templates`（市场列表/导入）。

**P3-4 sessionRetention 细化**
- `full`（默认，保留全部执行会话 .jsonl）/ `summary`（执行会话压缩为摘要，原始执行细节丢弃）/ `delete_after_days`（定时清理）。
- 实现：压缩器复用 pi auto-compaction 产物；清理任务挂运行历史巡检。

---

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 双状态源不一致（P0） | Event Sourcing 硬约束：events.jsonl 唯一事实来源，投影只读派生，禁止增量改状态文件 |
| Agent 污染状态（P0） | 受控工具集 + Runtime validate 后才产生 Event；输出文本永不直接改状态 |
| 上下文 token 成本 | 三层结构 + scope 三档 + 产物走文件 + pi auto-compaction |
| 幻觉叠加 | Artifact First：ArtifactRef 带 producedByExecutionId，角色 read 验证 |
| 返工/任意循环 | maxReworkRounds + maxHops + maxTurns + maxRunMinutes 四保险 |
| LLM 判定成本/不稳 | 判定顺序固定：handoff → keyword → always → LLM 一次判定候选集；llm 可关 |
| @mention 误触发 | 已降级 UI 层，非 Runtime 协议 |
| 规则配置错误 | validate.ts（error 阻断 / warning 提示，7 类检查） |
| 转项目组历史体积 | 剔除工具调用/结果，只导入 user/assistant 文本 |
| 崩溃恢复 | events.jsonl append-only + fsync；snapshot 可重建 |
| 多角色同写一文件 | Phase 1 顺序执行无冲突；Phase 2 worktree 隔离 |
| 会话文件膨胀 | 角色执行 .jsonl 按 execution 独立；sessionRetention 预留 |
| 时间戳冲突 | event.sequence 单调递增（不依赖 createdAt） |

---

## 12. 测试策略

1. **单元测试**：
   - EventReducer：事件序列 → 投影正确性（顺序敏感）；snapshot 恢复（部分重放）。
   - 计数语义：正常流 hopCount=4/reworkCount=0；返工流递增；循环触发 maxHops。
   - 路由判定顺序：handoff 优先于 keyword；keyword 优先于 always；LLM 只调一次。
   - 受控工具：非法 handoff（self-loop/白名单外/目标不存在）被拒；Agent 文本不产生状态变更。
   - 条件判定：keyword 屏蔽代码块、rejectKeywords 优先、llm 降级。
   - validate.ts：7 类检查（error/warning 分级）。
   - 历史导入：user/assistant → message_created 事件、工具结果剔除。
2. **API 测试**：生命周期、角色库、Transition CRUD、validate、run、SSE 重连（Last-Event-ID）。
3. **端到端（关键）**：`node` 驱动 TeamRuntime 真实跑完整流程，断言：
   上下文含结构化任务/进度/产物、hopCount/reworkCount 正确、产物真实生成、
   ArtifactRef.producedByExecutionId 正确、strict 模式不乱路由、崩溃后 replay 恢复。

---

## 13. 实现偏差与踩坑记录（Phase 1A/1B 实录）

> 设计稿与实现的偏差、实现期踩坑。后续阶段（1C/2/3）必须遵守；
> 这也是 pi-studio「后续新增项目知识优先写 docs/agents/」的落地。

| # | 主题 | 内容 |
|---|---|---|
| 1 | **`__end__` 终态节点（设计偏差）** | 设计稿 §1.4 原计划「入口角色收尾=completed、不特判任何角色」，但实测组长收尾依赖 keyword 路由，模型输出随机性导致 keyword 不命中 → run 永不结束。修复：templates.ts 显式加 `组长 → keyword[通过/完成/没问题] → __end__` 终态边，runtime 遇 `route.to === END_NODE` 直接 `finish(completed)`。`__end__` 非 Agent：validate 跳过、UI 渲染为终止圆点。「`__entry__` 只在 UI 渲染」保留，但**新增 `__end__` 为真实终态路由目标**（§3.2 应一并理解） |
| 2 | **Node strip-only 不支持参数属性** | 测试运行 `node --test` 时 strip-only 无法处理 `constructor(private x)` 类型参数属性 → 必须 `--experimental-transform-types` + 自写 `node-loader.mjs`（解析 `@/` 别名 + 无扩展名 .ts import）。后续新测试文件都按此运行（见各 test 文件头注释） |
| 3 | **pi 的 `_systemPromptOverride` 私有且被 base prompt 刷新覆盖** | 角色 systemPrompt 不能靠 override 注入 → 改为「首条消息 = 角色 prompt + 共享上下文 + 任务指令」，prompt resolve = 一次完整回合完成（executor.ts 注释有记录） |
| 4 | **SDK newSession 惰性落盘** | `createTeam` 不依赖 SDK 自动落盘，需手动写最小会话文件（身份/生命周期/Sidebar 需要），否则会话列表看不到新项目组 |
| 5 | **E2E 模型选择** | `firstAvailableModel` 跳过 VL/embedding/reranker（不能当对话模型），优先 new-provider 公司网关（实测可用）；支持 `PI_TEAM_E2E_MODEL` env 显式覆盖；无模型配置自动 skip（完整逻辑由 runtime.test.mjs mock 覆盖） |
| 6 | **keyword 路由不稳 → E2E 断言不赌固定 hops** | 模型输出随机性使 keyword 命中不可控 → 真实 E2E（e2e.test.mjs）只跑「组长→文档→组长收尾」并断言真实链路（事件存在/产物生成/执行次数>0）；确定性路由逻辑由 engine.test.mjs mock 覆盖。4 角色全链流程不在真实 E2E 里赌 |
| 7 | **hybrid 兜底回入口也算返工** | runtime 的 hybrid 兜底分支（无路由回 entry）同样递增 reworkCount（`bumpRework`），防止「总兜底回入口」隐性循环；与 `isReworkEdge` 显式返工边统计分离 |
| 8 | **i18n 规模** | zh-CN 28 个 `team.*` key（lib/i18n/messages/）；冒烟 curl 终端中文乱码是显示编码问题，非数据问题 |
| 9 | **convert 冒烟教训** | 转换测试曾误用真实会话（deleteTeam 的 resolveSessionPath 未命中，遗留小会话未删）→ 教训：convert 冒烟必须用临时会话，且 deleteTeam 需能按 sessionId 精确删除宿主会话+目录+index 条目 |

---

## 14. 参考

- frakio-work `docs/multi-agent-collaboration.md`（DAG 协作理念，不抄代码）
- pi-studio `lib/rpc-manager.ts`、`lib/session-reader.ts`
- 架构评审意见 ×2（2026-08-23，v3→v4、v4→v5 核心输入）
- 长期记忆「多Agent群聊功能方案调研」（决策记录）
