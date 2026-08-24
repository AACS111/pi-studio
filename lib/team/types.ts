/**
 * 项目组（Multi-Agent Team）—— 数据模型与事件模型（设计稿 v5 §3 / §4）。
 *
 * Event Sourcing 硬约束：
 *  - events.jsonl 是唯一事实来源（append-only）
 *  - TeamState / TeamMessage / TeamTask / AgentExecution / Artifact 全是投影（Projection）
 *  - reduce() 是纯函数：events → Projections（可回放、可崩溃恢复）
 *  - snapshot 只是性能优化，可随时删除重建
 */

/** ==================== 角色（AgentDef）与角色库 ==================== */

export type RoutingPolicy = "inherit" | "strict" | "hybrid" | "autonomous";

export interface AgentDef {
  id: string;                 // 组内唯一
  name: string;               // 显示名
  emoji?: string;
  role: string;               // 职责描述（展示 + 注入 prompt 开头）
  model: string;              // 模型 ID；空字符串 = 跟随全局默认
  systemPrompt: string;
  toolNames: string[];        // 工具白名单
  skillIds?: string[];        // 复用 pi-studio skill 体系
  workspace?: {
    mode: "team" | "isolated";  // 默认 "team"；Phase 2 接 worktree
    cwd?: string;
  };
  routingPolicy?: RoutingPolicy;    // 默认 "inherit"（跟随团队 defaultRoutingMode）
  handoffPolicy?: {
    allowedTargets?: string[];      // 白名单（空 = 受 Workflow 约束）
    allowSelfHandoff?: boolean;     // 默认 false
  };
  contextPolicy?: {
    scope: "structured" | "summary" | "recent";  // 覆盖团队默认
    recentCount?: number;
  };
  maxTurns?: number;          // 单次执行最大会话内轮次（默认 20）
  maxOutputChars?: number;    // 产出截断上限（默认 4000）
  timeoutMs?: number;         // 单次执行超时（默认继承 maxRunMinutes）
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";  // 推理级别（透传 startRpcSession；缺省=模型默认）
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

/** ==================== Workflow：Transition + Condition + 网关 ==================== */

export type TransitionEvent = "completed" | "failed" | "timeout" | "handoff" | "any";

/**
 * 网关节点（n8n / Dify 式结构化路由，参考 BPMN 语义）：
 *  - exclusive 排他：多条出边按条件选一条（keyword/always/llm + priority，与角色出边同机制）
 *  - parallel 并行：所有出边全部执行（分支各自推进，汇聚用 merge）
 *  - inclusive 包容：命中条件的出边都执行（keyword/always；不配条件=全走）
 *  - merge 汇聚：等待所有入边到达后继续（AND-join；缺分支时容错推进）
 */
export type GatewayType = "exclusive" | "parallel" | "inclusive" | "merge";

export interface GatewayDef {
  id: string;                 // 组内唯一（建议 gw- 前缀；与 agent id 同命名空间，transitions 的 from/to 均可引用）
  type: GatewayType;
  name: string;
  emoji?: string;
  description?: string;
}

export interface Transition {
  id: string;
  from: string;               // 源节点：Agent id | 网关 id
  to: string;                 // 目标节点：Agent id | 网关 id | __end__
  priority: number;           // 默认 0；同 from 多候选时 DESC 取第一个
  trigger: {
    event: TransitionEvent;   // 默认 "completed"
    condition?: Condition;
  };
  enabled?: boolean;
}

export type ConditionMode = "keyword" | "llm" | "always";

export interface Condition {
  mode: ConditionMode;
  keywords?: string[];        // keyword：产出含任一词即触发
  rejectKeywords?: string[];  // 含任一词强制不触发（优先级高于 keywords）
  conditionText?: string;     // llm：自然语言条件（最后决策器，候选集一次判定）
}

/** Workflow 静态校验（保存前调用） */
export interface WorkflowValidationResult {
  valid: boolean;
  errors: ValidationIssue[];    // 阻断保存
  warnings: ValidationIssue[];  // 仅提示
}

export interface ValidationIssue {
  code: string;
  message: string;
  transitionId?: string;
  agentId?: string;
}

/** ==================== 项目组（TeamDef） ==================== */

export type RoutingMode = "strict" | "hybrid" | "autonomous";
export type ContextScope = "structured" | "summary" | "recent";
export type SessionRetention = "full" | "summary" | "delete_after_days";  // Phase 1 默认 full

export interface ReworkEdge {
  from: string;
  to: string;
}

export interface TeamDef {
  sessionId: string;          // Team-backed Session 的宿主 pi 会话 id
  name: string;
  cwd: string;
  entryAgentId: string;       // 入口角色（Runtime 不用 __entry__ 节点）
  agents: AgentDef[];
  transitions: Transition[];
  gateways?: GatewayDef[];    // 网关节点（排他/并行/包容/汇聚）
  nodePositions?: Record<string, { x: number; y: number }>;  // 画布节点位置（拖动持久化；缺省用自动布局）
  reworkEdges?: ReworkEdge[];     // 显式声明返工边
  defaultRoutingMode: RoutingMode;  // 默认 "hybrid"；Agent.routingPolicy 可覆盖（Phase 2）
  maxHops: number;            // 默认 30（防任意循环）
  maxReworkRounds: number;    // 默认 3（只统计返工边）
  maxRunMinutes: number;      // 默认 30
  contextScope: ContextScope; // 默认 "structured"
  recentCount?: number;       // scope=recent 时（默认 20）
  sessionRetention?: SessionRetention;  // Phase 1 不实现，仅预留
  createdAt: number;
  updatedAt: number;
}

/** ==================== Run + AgentExecution + TeamTask ==================== */

export type TeamRunStatus =
  | "pending" | "running" | "waiting_handoff"
  | "completed" | "failed" | "cancelled";

export type RunStopCode =
  | "completed" | "max_hops" | "max_rework" | "timeout"
  | "agent_failed" | "workflow_dead_end" | "user_cancelled";

export interface TeamRun {
  id: string;
  teamId: string;             // = sessionId
  status: TeamRunStatus;
  task: string;
  statusReason?: {            // UI 直接展示停止原因
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
  // 不含 messages/tasks/state —— 全部为投影
}

export type ExecutionStatus = "running" | "completed" | "failed" | "cancelled";

export interface AgentExecution {
  id: string;
  runId: string;
  agentId: string;
  sequence: number;           // 该角色在本 run 中的第几次执行
  status: ExecutionStatus;
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
  createdBy: string;          // "runtime" | "user" | agentId
  title: string;
  description: string;
  assignedAgentId: string;
  status: TaskStatus;
  parentTaskId?: string;
  dependsOn?: string[];       // Phase 1 仅预留；Phase 2 并行时使用
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

/** ==================== 投影：TeamState / Decision / TeamMessage / Artifact ==================== */

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
  producedByExecutionId: string;   // ★ 哪次执行产生（溯源链 Artifact→Execution→Agent）
  version?: string;
}

export interface HandoffPayload {
  task?: string;
  summary?: string;
  artifacts?: ArtifactRef[];
  decisions?: Decision[];
  blockers?: string[];
}

/** ==================== 事件模型（唯一事实来源） ==================== */

export type TeamEvent =
  | { type: "run_started"; sequence: number; timestamp: number; runId: string; task: string; entryAgentId: string }
  | { type: "task_created"; sequence: number; timestamp: number; task: TeamTask }
  | { type: "task_completed"; sequence: number; timestamp: number; taskId: string }
  | { type: "task_failed"; sequence: number; timestamp: number; taskId: string; reason?: string }
  | { type: "execution_started"; sequence: number; timestamp: number; execution: AgentExecution }
  | { type: "message_created"; sequence: number; timestamp: number; message: TeamMessage }
  | { type: "artifact_produced"; sequence: number; timestamp: number; artifact: ArtifactRef }
  | { type: "decision_recorded"; sequence: number; timestamp: number; decision: Decision }
  | { type: "handoff_requested"; sequence: number; timestamp: number; executionId?: string; from: string; to: string; kind: "transition" | "tool"; transitionId?: string; reason?: string }
  | { type: "execution_completed"; sequence: number; timestamp: number; executionId: string; status: ExecutionStatus; handoffTo?: string; failureReason?: string }
  | { type: "steer"; sequence: number; timestamp: number; agentId?: string; content: string }
  | { type: "run_completed"; sequence: number; timestamp: number; statusReason: { code: RunStopCode; message: string } }
  | { type: "run_failed"; sequence: number; timestamp: number; statusReason: { code: RunStopCode; message: string } }
  | { type: "run_cancelled"; sequence: number; timestamp: number; statusReason: { code: RunStopCode; message: string } };

/** 事件输入：sequence/timestamp 由 EventStore 分配（手写保留判别联合） */
export type TeamEventInput =
  | { type: "run_started"; runId: string; task: string; entryAgentId: string }
  | { type: "task_created"; task: TeamTask }
  | { type: "task_completed"; taskId: string }
  | { type: "task_failed"; taskId: string; reason?: string }
  | { type: "execution_started"; execution: AgentExecution }
  | { type: "message_created"; message: TeamMessage }
  | { type: "artifact_produced"; artifact: ArtifactRef }
  | { type: "decision_recorded"; decision: Decision }
  | { type: "handoff_requested"; executionId?: string; from: string; to: string; kind: "transition" | "tool"; transitionId?: string; reason?: string }
  | { type: "execution_completed"; executionId: string; status: ExecutionStatus; handoffTo?: string; failureReason?: string }
  | { type: "steer"; agentId?: string; content: string }
  | { type: "run_completed"; statusReason: { code: RunStopCode; message: string } }
  | { type: "run_failed"; statusReason: { code: RunStopCode; message: string } }
  | { type: "run_cancelled"; statusReason: { code: RunStopCode; message: string } };

/** ==================== 投影与快照 ==================== */

export interface Projections {
  state: TeamState;
  messages: TeamMessage[];
  tasks: TeamTask[];
  executions: AgentExecution[];
  artifacts: ArtifactRef[];
}

export interface TeamSnapshot {
  eventSequence: number;      // 快照包含到的最后 sequence
  projections: Projections;
}

/** 创建空投影 */
export function emptyProjections(): Projections {
  return {
    state: {
      goal: "",
      phase: undefined,
      decisions: [],
      artifacts: [],
      completedTasks: [],
      activeTasks: [],
      blockers: [],
      lastHandoff: undefined,
    },
    messages: [],
    tasks: [],
    executions: [],
    artifacts: [],
  };
}

/**
 * 纯函数：events → projections（replay 用）。
 * 对同一事件序列调用结果一致（无随机、无外部副作用）。
 * run_completed / run_failed / run_cancelled 不改变投影（run 状态在 TeamRun meta）。
 */
export function reduce(events: TeamEvent[]): Projections {
  const p = emptyProjections();

  for (const event of events) {
    switch (event.type) {
      case "run_started":
        p.state.goal = event.task;
        p.state.phase = "planning";
        break;

      case "task_created":
        p.tasks.push(event.task);
        p.state.activeTasks.push(event.task.id);
        break;

      case "task_completed": {
        const task = p.tasks.find((t) => t.id === event.taskId);
        if (task) {
          task.status = "completed";
          task.completedAt = event.timestamp;
        }
        p.state.activeTasks = p.state.activeTasks.filter((id) => id !== event.taskId);
        if (!p.state.completedTasks.includes(event.taskId)) {
          p.state.completedTasks.push(event.taskId);
        }
        break;
      }

      case "task_failed": {
        const task = p.tasks.find((t) => t.id === event.taskId);
        if (task) {
          task.status = "failed";
          task.completedAt = event.timestamp;
        }
        p.state.activeTasks = p.state.activeTasks.filter((id) => id !== event.taskId);
        break;
      }

      case "execution_started": {
        p.executions.push(event.execution);
        for (const taskId of event.execution.taskIds ?? []) {
          const task = p.tasks.find((t) => t.id === taskId);
          if (task && task.status === "pending") {
            task.status = "running";
            task.startedAt = event.timestamp;
          }
        }
        break;
      }

      case "message_created":
        p.messages.push(event.message);
        break;

      case "artifact_produced":
        p.artifacts.push(event.artifact);
        p.state.artifacts.push(event.artifact);
        break;

      case "decision_recorded":
        p.state.decisions.push(event.decision);
        break;

      case "handoff_requested":
        p.state.lastHandoff = {
          from: event.from,
          to: event.to,
          reason: event.reason ?? "",
          executionId: event.executionId ?? "",
        };
        break;

      case "execution_completed": {
        const exec = p.executions.find((e) => e.id === event.executionId);
        if (exec) {
          exec.status = event.status;
          exec.completedAt = event.timestamp;
          exec.handoffTo = event.handoffTo;
          exec.failureReason = event.failureReason;
        }
        for (const taskId of exec?.taskIds ?? []) {
          const task = p.tasks.find((t) => t.id === taskId);
          if (task && task.status === "running") {
            task.status = event.status === "completed" ? "completed" : "failed";
            task.completedAt = event.timestamp;
          }
        }
        break;
      }

      case "steer":
        p.messages.push({
          id: `steer-${event.sequence}`,
          kind: "user",
          agentId: event.agentId,
          content: event.content,
          createdAt: event.timestamp,
        });
        break;

      // run_completed / run_failed / run_cancelled：不改变投影
      default:
        break;
    }
  }

  return p;
}
