# 单 Agent 会话 vs 项目组会话：在「解决问题」上的权衡分析与优化路线

> 分析对象：Pi Studio（`@aacs111/pi-studio`）当前实现（v0.8.6）
> 普通会话 = pi 原生单 Agent；项目组会话 = `lib/team/**`（Multi-Agent Team Runtime）
> 结合市面开源多 Agent 方案（MetaGPT / AutoGen / CrewAI / LangGraph / Agno）做对照与借鉴。
> 分析基于对 `lib/team/runtime.ts` `engine.ts` `context.ts` `executor.ts` `tools.ts` `types.ts` `templates.ts` `library.ts` 逐行阅读与实测。

---

## 0. TL;DR（结论先行）

| 维度 | 普通会话（单 Agent） | 项目组会话（Multi-Agent Team） | 谁更强 |
|---|---|---|---|
| **上下文连续性** | ✅ 完整无损耗（同一条绳） | ❌ 割裂（独立会话，靠压缩摘要接力） | 普通会话 |
| **深度推理型任务** | ✅ 强 | ⚠️ 弱（信息漏斗，重复造轮子） | 普通会话 |
| **多角色交叉验证** | ❌ 单点自认可 | ✅ 专职质检/测试交叉验证 | 项目组 |
| **专业分工/可复用** | ❌ 每次从头 | ✅ 角色/workflow 模板化 | 项目组 |
| **速度（简单任务）** | ✅ 快（一次闭环） | ❌ 慢（串行接力 + 多次启动） | 普通会话 |
| **速度（可并行任务）** | ❌ 单脑串行 | ⚠️ 名义并行、物理串行（待修） | 打平（当前都慢） |
| **成本（简单任务）** | ✅ 省 | ❌ 倒挂（极简任务也跑遍所有角色） | 普通会话 |
| **可审计/可回放** | ⚠️ 单会话可读 | ✅ 事件溯源 + 每角色独立会话 | 项目组 |
| **防跑飞** | ⚠️ 单点 | ✅ 四保险丝 + 受控工具 | 项目组 |
| **人工可控（approval/inspect）** | ✅ 随时可停 | ⚠️ 无审批闸门（P2-2 未做） | 普通会话 |

**核心结论**：当前项目组在「**需要深度推理、单线程可收敛、上下文强依赖**」的任务上**不如普通会话**；
在「**可并行拆解、需要质检交叉验证、流程可复用**」的任务上**优于普通会话**。
但当前项目组的潜力远未释放——**物理串行 + 上下文割裂 + keyword 路由不稳 + 简单任务成本倒挂** 是四个压制点。

---

## 1. 两种运行形态的本质差异

### 1.1 普通会话（单 Agent）——「开放式单脑」

- **模型 = 完整 Agent**：1 个 LLM + 全套工具 + 完整 cwd + 连续会话历史（超长自动 compact）。
- **解决问题的方式**：Agent 内部自驱动循环——感知 → 推理 → 调工具 → 观察结果 → 再推理 → 收敛。
- **上下文是"同一条绳子"**：所有思维、每步推理、每个工具结果都挂在同一条连续上下文里，模型始终能看到"我刚刚为什么这么想、改了什么"。
- **对应开源范式**：OpenAI Agent SDK / Claude Code / pi 原生 / OpenHands。核心杠杆是**单模型长程推理 + 工具负反馈**。

### 1.2 项目组会话（Multi-Agent Team）——「SOP 流水线」

- **模型 = 编排的 N 个角色**：每个角色是一个**独立的 pi 会话**（`executor.ts` 里 `startRpcSession`），各有独立 `systemPrompt` / `model` / `toolNames` / `skillIds`。
- **解决问题的方式**：沿 `transitions` / `gateways` 串行接力。每角色只看到 `context.ts` 构建的**结构化上下文**（任务 + 进度 + 决策 + 产物）+ 上一角色**压缩后的摘要**，各自独立推理，通过 `team_handoff` / `team_create_task` 等受控工具影响状态。
- **对应开源范式**：MetaGPT（SOP 流水线 + 消息池）+ CrewAI（角色 crew + 任务期望输出）+ LangGraph（图编排 + 检查点）+ Agno（team 共享上下文）。
- **核心目标**：专业分工 + 交叉验证 + 流程复用 + 可审计（Event Sourcing）。

---

## 2. 各自优缺点（站在"解决同一个问题"的视角）

### 2.1 普通会话的优点

1. **上下文连续、推理链完整**：模型能看到全部思维轨迹，深度一致，不会"忘了为什么这么做"。
2. **单次成本低、缓存命中高**：同一条上下文递增，`cacheRead` 命中率高，token 便宜。
3. **收敛快、交互少**：一次交互、一个模型自闭环，不需要多角色接力 + 多次 `startRpcSession` 启动开销。
4. **灵活自适应**：无 workflow 约束，模型自行拆解边界情况，遇到意外能当场调整。

### 2.2 普通会话的缺点

1. **单点盲区**：一个模型自说自话，缺少"第三人视角"交叉验证。
2. **自我认可倾向**："我写的当然没问题"——开发自己验自己的代码很难发现问题。
3. **长任务上下文膨胀**：超长任务要 compact，可能丢失早期关键细节。
4. **无专业分工 / 无复用**：每次从零推理，同类任务不沉淀结构。

### 2.3 项目组会话的优点

1. **专业分工 + 交叉验证**：开发写让测试质检，防自我认可（这是多 Agent 最核心的价值）。
2. **可审计、可回放**：Event Sourcing 唯一事实来源，每角色每执行独立会话、独立 token，链路透明。
3. **结构可复用**：角色/workflow 存成模板，同类任务一键复用。
4. **受控状态修改**：Agent 只能通过受控工具影响状态，输出文本永不污染 `state`。
5. **并行潜力**：`gateway.parallel` 语义上支持分支并行（但当前物理未实现，见 §3）。

### 2.4 项目组会话的缺点（当前实测/代码确认）

| # | 痛点 | 代码依据 | 后果 |
|---|---|---|---|
| 1 | **上下文割裂（最致命）** | 每角色独立 pi 会话，`context.ts` 只注入压缩摘要（`summarize` 120/300 字）；`recentAgentSummaries` 只取每角色最后一条产出 | 信息漏斗、重复造轮子、深度推理链条断裂 |
| 2 | **物理串行（速度瓶颈）** | `runtime.ts` `while(pending.length)` 内 `pending.pop()` + `await this.executor.run()`，逐个执行；`gateway.parallel` 只是 `pending.push(to)` 压栈，**无 Promise.all** | 名义并行、实际一次一个角色，多分支任务慢 |
| 3 | **简单任务成本倒挂** | 无 solo/复杂度判断，`RunManager` 无条件跑 entry → 全链接力；示例实测极简任务 11 次执行 / 30w token | 便宜任务被做贵，性价比差 |
| 4 | **keyword 路由不稳** | 模板用 `keyword: ["问题","失败","bug"]` 判断返工，`keyword: ["通过","完成"]` 判断收尾；设计文档 §13#6 已记录模型随机性导致 miss | 返工/收尾漏判，靠 hybrid 兜底回入口（隐性返工加 reworkCount） |
| 5 | **交接信息损耗** | `handoff.summary` 限 200 字，`context.ts` 再截断；角色只见摘要不见全文 | 下游角色理解偏差 |
| 6 | **无人工审批闸门** | `approval`/`wait_for_user` 未实现（P2-2 未做） | 关键步骤（如合入主干、删文件）无法中途等人确认 |
| 7 | **无共享显式计划** | 组长 `team_create_task` 但 `RunManager` 不基于 task 调度；`dependsOn` 仅预留未启用 | 计划是"口头"接力，非可执行 DAG |
| 8 | **无验收标准（expected_output）** | `AgentDef`/`TeamTask` 无 `expectation`/`expectedOutput` 字段 | 角色交付质量无标尺，产出随意 |

---

## 3. 为什么当前项目组"慢"且"不稳"（代码级定位）

### 3.1 物理串行 —— `runtime.ts` 的执行循环

```ts
// runtime.ts:99 while 循环
while (pending.length > 0) {
  const nodeId = pending.pop()!;            // ← 一次取一个节点
  ...
  const result = await this.executor.run({ ... });  // ← 同步 await，阻塞到本轮角色跑完
  ...
  const route = await this.workflow.resolveRoute(...);
  pending.push(route.to);                    // 再 push 下一个
}
```

- `gateway.parallel` 在 `resolveGateway` 返回 `candidates.map(t => t.to)` → `runtime.ts:155 for(const to of targets) pending.push(to)`。
- **但 `pending` 是栈，循环每轮只 `pop()` 一个、`await` 一个**——即使多个分支已压栈，也是**先进后出逐个串行跑**，完全没有并发。
- → **要想真并行**，需把 `pending` 栈升级为「**ready-set 调度**」：收集到多个 ready 节点后用 `Promise.all` 并发执行，再用 merge 汇聚 `join`。

### 3.2 上下文割裂 —— `context.ts` 的注入策略

```ts
// recentAgentSummaries：每角色只取最后一条 agent 消息
function recentAgentSummaries(messages) {
  const byAgent = new Map();
  for (const m of messages) if (m.kind==="agent" && m.agentId) byAgent.set(m.agentId, m);
  return [...byAgent.entries()].map(([agentId, m]) => ({
    agentId, role: m.role ?? agentId,
    summary: summarize(m.content),        // ← 截断到 120 字
  }));
}
```

- 下游角色只拿到**每角色一条 120 字摘要**，看不到交接全文、看不到上一角色的完整修改过程。
- `buildContext` 的「最近消息」`structured` 档虽含最近消息，但同样每条约 300 字截断。
- → 适合「**可并行、可分段**」任务；不适合「**要沿一条推理链深挖**」的任务（后者普通会话更强）。

### 3.3 简单任务成本倒挂 —— 无 solo 降级

- `RunManager.execute()` 无条件 `pending=[entry]`，按 workflow 全链接力。
- 没有任何"这个任务是不是单 Agent 就能解决"的复杂度判断。
- → **极简任务也被拆到组长→产品→开发→测试→组长**，一次 run 反复启动 5 个独立 pi 会话，token 和延迟都是普通会话的数倍。

---

## 4. 市面开源多 Agent 方案的可借鉴点

| 开源方案 | 核心思想 | 对本项目的启发 | 落地映射 |
|---|---|---|---|
| **MetaGPT** | SOP 流水线 + 共享消息池 + long-term memory；每角色输出**标准化交付物**（PRD/Design/Task/Code） | 角色交付要**可验证的中间产物**；共享**显式状态黑板**而非口头交接 | 强化 `ArtifactRef` 溯源 + 共享 `state.decisions/artifacts` 黑板 |
| **CrewAI** | crew 角色（role/goal/backstory）+ 每 task 带 **`expected_output`** | **每个角色每次执行都要有验收标准**，产出质量有标尺 | 给 `AgentDef`/`TeamTask` 加 `expectation`，注入上下文 |
| **LangGraph** | 显式 state machine + **checkpoint** + **interrupt（人类在环）** | 状态显式、可中断、可恢复、可注入人工反馈；循环有界 | 实现审批闸门（P2-2）+ 事件流天然 checkpoint |
| **AutoGen** | 角色**对话驱动**，GroupChat manager 调度 | 对话式协作灵活，但易发散；需克制 | 保留受控工具路由，避免自由对话发散 |
| **Agno** | Team = agents 经**共享 session state** 异步协作；支持并行/串行 | 并行协作要共享上下文 + DAG 依赖 | 启用 `dependsOn` + ready-set 并行 + merge join |
| **OpenHands / Agent SDK** | 单 Agent + 事件流 + 安全沙箱 | 事件流 & 沙箱隔离仍是单 Agent 优点 | 保留单 Agent 作为"深度任务"的兜底 |

**共性方法论**（多 Agent 要强，缺一不可）：
1. **共享显式状态**：不是口头接力，而是可读写的黑板（计划/决策/产物/进度）。
2. **可验证中间产物**：每个角色产出要能被下个角色 `read` / 执行验证，而非"我说完成了"。
3. **并行 + 汇聚**：无依赖分支真并发，有依赖处 merge join。
4. **人类在环**：关键节点可暂停/批准/喂反馈。
5. **结构化解耦**：路由判定尽量用结构化信号（决策/状态），少赌自由文本 keyword。

---

## 5. 优化路线（提速 / 提准 / 提体验）

### P0 —— 收益最大、改动可控，建议优先

| # | 优化 | 目标 | 关键改动 |
|---|---|---|---|
| P0-1 | **简单任务 solo 降级** | 提速 + 省钱 | 任务复杂度判断：复杂 → 全链；简单 → 只跑 entry 收尾。可在 `RunManager` 加 `soloCapable` 判定或 `TeamDef.autoSolo` 开关 |
| P0-2 | **交接全文注入** | 提准（治上下文割裂） | `context.ts`：把上一 `handoff.summary` 全文（非 120 字截断）和上一角色最终输出注入给下游；`recentAgentSummaries` 提高上限或注入完整交接块 |
| P0-3 | **真正并行调度** | 提速（多分支） | `runtime.ts`：pending 栈升级为 ready-set + `Promise.all` 并发执行，`gateway.parallel`/`inclusive` 物理并发，`merge` 做 `join` 汇聚 |
| P0-4 | **expected_output 验收标准** | 提准 | `AgentDef.expectation` + `TeamTask.expectedOutput`，注入上下文，指引角色按标尺交付 |

### P1 —— 提升可靠性 & 结构完整性

| # | 优化 | 目标 | 关键改动 |
|---|---|---|---|
| P1-1 | **结构化路由信号（弃 keyword 赌）** | 提准 + 稳 | 测试角色用 `team_record_decision` 记录 `pass/fail` 决策；`resolveRoute` 优先读 `state.decisions` 等结构化信号，而非赌输出关键词 |
| P1-2 | **人工审批闸门** | 提体验 + 可控 | `Transition.approval` + `approval_requested` 事件 + 运行 `waiting_approval`；批准/驳回走 API（对应 P2-2） |
| P1-3 | **共享计划黑板（DAG 调度）** | 提准 + 并行 | 启用 `TeamTask.dependsOn`；组长先 `team_create_task` 写计划，`RunManager` 按 task DAG 调度而非纯 workflow 接力 |
| P1-4 | **LLM judge 事件化** | 提准 | 路由 LLM 判定的结构化（如条件编号），避免自由文本 |

### P2 —— 深度能力（既有设计稿已规划）

| # | 优化 | 说明 |
|---|---|---|
| P2-1 | **worktree 隔离** | `workspace.mode=isolated`，开发在独立 worktree，冲突/回滚可控（设计稿 P2-1） |
| P2-2 | **跨 run 记忆** | 角色记住跨任务经验（P3-2），减少重复踩坑 |
| P2-3 | **执行回放 UI** | 按事件流回放，逐事件高亮（P2-5） |

---

## 6. 推荐的第一步落地（最小改动、最快见效）

1. **P0-1 solo 降级**：给 `RunManager` 加一个"复杂度判断"，当任务不需要拆解时，只让 entry 角色跑完即 `run_completed`。这是**最立竿见影**的优化——直接解决"简单任务 30w token"的痛点，也利落地解决了"项目组比普通会话慢/贵"的表面问题。

2. **P0-2 交接全文注入**：改 `context.ts`，把上一角色的交接摘要（不截断）和最终产出注入给下一个角色。这个改动**只影响上下文构建**，风险低，但显著提升下游角色对上游工作的理解。

---

## 7. 结语

- **普通会话** 适合：深度推理、单线程可收敛、上下文强依赖、追求降本的任务。
- **项目组会话** 适合：可并行拆解、需要质检交叉验证、流程可复用、需要审计的任务。
- **当前项目组是"骨架已成型、但性能/稳定性未释放"**：`gateway.parallel` 语义已有但物理未实现；keyword 路由不稳；无 solo 降级；无审批闸门；无 expected_output。
- 建议按 **P0（solo 降级 + 交接全文 + 真并行 + expected_output）→ P1（结构化路由 + 审批闸门 + 共享计划）→ P2（worktree + 跨 run 记忆）** 顺序推进，每次只改一个点并 tsc/lint + 端到端验证。

---

## 8. 落地进度（2026-08-24）

### ✅ 已落地并验证（`tsc --noEmit` 过、改动源码 eslint 0 error、核心测试 66/66 全绿）

| 项 | 落地内容 | 借鉴来源 |
|---|---|---|
| **P0-1 solo 降级** | `TeamDef.autoSolo` + `RunManager.shouldSolo()`（短任务 + 无复杂术语黑名单 → 只跑入口角色即 `run_completed`） | 普通会话单代理闭环 |
| **P0-2 上一环节完整产出注入** | `context.ts` 注入上一角色**完整产出**（非 120 字截断）+ 本角色期望产出 | 治上下文割裂 |
| **P0-4 expected_output 验收标准** | `AgentDef.expectation` + 6 个内置角色 expectation + `TeamTask.expectedOutput` 注入 | **CrewAI** `expected_output` |
| **P1-1 结构化裁决** | `Transition.verdictGuard` + `record_decision` 支持 `verdict`；`engine.resolveRoute` 在 keyword 判定前**优先匹配 verdictGuard 结构化裁决边**（弃 keyword 赌） | 弃 keyword 不稳 |
| **P1-2 人工审批闸门** | `Transition.approval` + `approval_requested/approval_resolved` 事件 + `RunStatus.waiting_approval` + `approve()/reject()` API + TeamChat 批准/驳回按钮 | **LangGraph** human-in-loop |
| **共享任务黑板** | 共享任务列表 + `dependsOn` 依赖透出进上下文，planner/下游可读 | **MetaGPT** 共享黑板 + **Agno** DAG |
| **P0-3 真并行调度** | `runtime.ts` 执行循环重构为「波次就绪集 + `Promise.all` 并发」：parallel/inclusive 网关分叉出的独立分支在同一波次真并发；merge（AND-join）按入边计数+容错 join；事件单写者严格单调 | 参考 Agno/OpenHands 事件流并行 |
| **上下文黑板（完整性）** | `context.ts` 新增「全链路关键产出」：注入最近若干角色（默认 4 个）的**完整产出**（替代 120 字摘要），并把最近消息截断上限 300→600 字，让下游角色看到真实推理链而非“猜”片段 | 治上下文割裂 |
| **可重入 merge（返工回流）** | `runtime.ts` `arriveMerge` 改为可重入：merge 已释放后若来一个新 token（如返工修复后重进并行区），重置为该轮并配合容错推进，使「修复→复验」能从并行区正确回流，不再卡死 | 补齐 fork-join 返工闭环（LangGraph/AutoGen 常见痛点） |
| **solver 并行解题模板** | 新增内置模板 `solver`：组长(入口) 经 `parallel` 网关并行分派 研究员/开发/文档 三个独立分支（真并发）→ `merge` → 测试交叉验证（verdictGuard pass/fail）→ 组长汇总；适合“可拆分成独立子任务”的复杂问题 | 速度(并行) + 准确性(质检) 双收 |

### 🔜 待办（高重构风险/长周期，未实施）

| 项 | 说明 | 风险 |
|---|---|---|
| **P1-3 完整 DAG 调度引擎** | 基于 `TeamTask.dependsOn` 由 RunManager 调度任务而非纯 workflow 接力；依赖 P0-3 真并行 | 高 |
| **P1-4 LLM judge 事件化** | 路由 LLM 判定结构化（如条件编号） | 中 |
| **P2 worktree 隔离 / 跨 run 记忆 / 执行回放 UI** | 见既有设计稿 | 长周期 |

### 本次新增文件

- `lib/team/enhance.test.mjs`（6 个新测试：solo 降级、verdict 结构化裁决、approval 批准/驳回、上下文增强）
- `app/api/teams/runs/[runId]/approve/route.ts`、`app/api/teams/runs/[runId]/reject/route.ts`
- `lib/team/parallel.test.mjs`（4 个新测试：真并发时间重叠证明、并行事件单调/不重复回填、嵌套并行、并行容错 join）
- `lib/team/benchmark.test.mjs`（6 个基准：复杂问题缺陷捕获、并行加速、简单任务成本倒挂、复杂问题团队 vs 串行单脑、纯并行墙钟加速 vs 单脑）
- `lib/team/solver.test.mjs`（3 个端到端：并行分叉+交叉验证 pass、缺陷返工 loop、上下文黑板完整性）

### 关键决策

- 模板**默认不开启 autoSolo**：否则现有 runtime/gateway/lifecycle 短任务测试会触发 solo 破坏断言；仅当用户显式开启时生效。
- `verdictGuard` 仅在 `result.verdict` 存在时生效：现有 mock（无 verdict）测试行为不变，向后兼容。
- solo 判定含复杂术语黑名单（分析/实现/开发/测试…），避免「库存差异分析」这类任务被误判为简单。
- P0-3 并行采用**波次（wave）模型**而非完全数据流：同一波次内独立分支真并发；不同深度分支分属不同波次（浅分支先到 merge 停靠）。对模板典型形态（parallel 网关 → 并行角色 → merge）即达全并发；深层/浅层混布时分波串行是已接受的取舍（换取事件顺序可预测、零竞态）。

---

## 9. 量化评估：项目组多 Agent vs 普通单 Agent + 对照市面主流（2026-08-24）

> 数据来自 `lib/team/benchmark.test.mjs` 的可复现结构基准（mock 执行器模拟角色行为，无真实 LLM）。
> 以下「准确率/增强」是**架构层可量化信号**（质检覆盖、缺陷捕获、并行加速、成本），不是对有限标注集的 LLM 语义准确率分数
> ——后者需真实模型 + 标注集另测。但结构的优劣直接决定在无独立验证者时 LLM 自我认可带来的漏判，故下述结论可作架构路线参考。

### 9.1 实测基准（`node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/team/benchmark.test.mjs`）

| 基准 | 团队（项目组） | 普通单 Agent | 量化结论 |
|---|---|---|---|
| **A 复杂问题含隐藏缺陷** | tester 独立复核 developer 产出 2 次（首次 `verdict:fail` → 返工 developer#2 修复 → 再复核 `verdict:pass`） | 单脑自闭环 1 次，输出含“通过/达标”即自判收敛 | **缺陷捕获率：团队 100% / 单脑 0%**；质检覆盖 2 vs 0 次 |
| **B 可并行任务（3 模块各 60ms）** | parallel 分叉真并发 | 串行 | **墙钟加速 ≈ 2.25x**（3 模块并发窗口 + 组长拆解/收尾开销） |
| **C 简单任务成本** | autoSolo 降级 → 1 次执行 | 全链 5 次执行 | **成本比 ≈ 5.0x**（简单任务从“跑遍所有角色”收敛为“单个入口收尾”） |
| **D 复杂可分解问题（4 模块，含隐藏缺陷）** | 并行 4 分支 + 测试质检（tester 复核 2 次）→ 捕获缺陷并返工 | 单脑串行 + 自我认可 → 缺陷被放行 | **团队 221ms 且缺陷捕获=是；单脑 293ms 且缺陷捕获=否** |
| **E 复杂可分解问题（并行全通过）** | 并行 4 分支 60ms + 质检 30ms + 汇总 | 串行 4 模块 60ms×4 + 自检 | **团队 120ms vs 单脑 283ms → 墙钟加速 ≈ 2.36x** |

### 9.2 根因：项目组在“复杂问题”上的增强/准确率来源

**增强（能力增量）主要来自 5 点：**
1. **交叉验证（最核心的准确率杠杆）**：单 Agent 天然自我认可（“我写的当然没问题”），缺乏第三方视角；项目组引入产品/开发/测试专职角色，测试对开发产出做**结构化裁决（verdict pass/fail）**，命中 fail 即强制返工——这是把 LLM 自我盲区转化为可校正闭环的机制。
2. **可并行拆解（P0-3 + solver 模板落地后生效）**：`parallel` 网关把无依赖子任务分成独立分支真并发，把“深度推理型串行”变“广度展开型并发”，墙钟显著更快（基准 E 2.36x）。
3. **上下文黑板（完整性）**：把“各角色 120 字摘要 + 上一角色完整产出”升级为“最近若干角色**完整产出**共享”，堵住下游“猜”上游推理的漏判（基准 solver 测试 3）。
4. **流程复用 + 验收标准（P0-4）**：角色/工作流模板化，`expectation`/`expectedOutput` 注入让每个角色有明确“什么算交付”，减少产出随意。
5. **人工在环（P1-2）+ 可重入返工闭环**：关键边可暂停等待批准（LangGraph interrupt）；merge 可重入使“失败→修复→复验”能在并行区正确回流（基准 D）。

**但项目组在“深度推理型单线程可收敛、上下文强依赖”的任务上弱于单 Agent：**
- 独立会话导致信息漏斗（已用 P0-2/P0-3 全链黑板注入缓解，但仍是“接力”而非“同一条绳”）；
- 每次交接 + 每次 `startRpcSession` 启动开销，token/延迟高于单 Agent；
- 深度/窄上下文依赖的表征在有限上下文中更易丢失中间推理。

**结论（分任务类型）**：
- **可并行分摊 + 需质检 + 可复用流程**的复杂任务 → 项目组**明显更强且更快**（基准 E：并行 2.36x 快于串行单脑；基准 D：含缺陷仍更快且缺陷捕获 100% vs 0%；流程沉淀）。
- **单线程深推理、强上下文依赖**的复杂任务 → 单 Agent 更强（上下文连续、缓存命中高、深度一致）。
- 因此实际工程里不应二选一，而应是：**单 Agent 兜底深推理，项目组处理可并行/需质检的规模化任务**；当前 `autoSolo` 已内置该分流开关，`solver` 模板即“复杂可分问题”的推荐形态。

### 9.3 对照市面主流多 Agent：还需要哪些改进优化

| 主流方案 | 核心思想 | 对项目组**领先/持平/待补** |
|---|---|---|
| **MetaGPT** | SOP 流水线 + 共享消息池 + 每角色标准化交付物（PRD/Design/Task/Code） | ✅ 持平（共享任务黑板 + 产物溯源已具备）；待补：交付物**类型化 schema** 强约束 |
| **CrewAI** | crew 角色(role/goal/backstory) + 每 task 带 `expected_output` | ✅ 已补上 `expected_output`（P0-4）；待补：task 级 `expected_output` 校验（当前仅注入提示，无自动比对） |
| **LangGraph** | state machine + checkpoint（事件流天然是）+ **interrupt 人类在环** | ✅ 已补上审批闸门（P1-2）+ 事件流 checkpoint；待补：任意节点可**原地恢复**（当前中断后不可 resume for 一个 run 重放续跑） |
| **AutoGen** | 对话驱动 GroupChat manager | ⚠️ 项目组刻意**避免自由对话**（用受控工具路由），更可控但弹性略低；待补：无预置的自由会话协作模式 |
| **Agno** | team = agents 经共享 session state 异步协作；支持并行/串行 | ✅ 并行已落地（P0-3）；待补：完整 DAG 任务调度（依赖 `dependsOn` 而非纯 workflow 接力） |
| **OpenHands/Agent SDK** | 单 Agent + 事件流 + 安全沙箱 | ✅ 事件流保留；待补：**worktree 隔离**（开发在独立分支，冲突回滚可控） |

**项目组相对主流仍最需补齐的 3 项（按价值/风险排序）：**
1. **完整 DAG 任务调度（P1-3）**：现在跑的是“workflow 接力”，不是“基于 task DAG 调度”；打通 `TeamTask.dependsOn` → ready-set 调度后，才能像 Agno/LangGraph 一样按依赖就绪集并发。依赖已具备（P0-3 就绪集 + `dependsOn` 已在上下文透出），剩余是把“任务排程”接入执行循环。
2. **LLM judge 结构化（P1-4）**：路由判定从 keyword 升级为 LLM 判定的**结构化作答**（返回条件编号而非自由文本），减少随机性。当前 `verdictGuard` 已把“测试通过/失败”这一最关键路由结构化，其余候选仍走 keyword/llm。
3. **worktree 隔离（P2-1）**：`workspace.mode=isolated` 语义已预留但未接真实 worktree；开发/测试在独立分支才能做真正的并行不互相覆盖（冲突可控、回滚可见）。

### 9.4 对“普通会话 vs 项目组”的最终定位

- **普通会话**：开放式单脑，上下文连续、深推理强、简单任务便宜、缓存命中高。适合**深度推理、单线程可收敛、强上下文依赖**。
- **项目组**：SOP 流水线，专业分工 + 交叉验证 + 流程复用 + 可审计 + 可并行。适合**可并行拆解、需质检、流程可复用**。
- **一句话**：把“单 Agent 的自我认可”这个准确率黑洞，换成“测试角色结构化裁决”的闭环（缺陷捕获 0→100%）；把“单线程串行”换成“parallel 网关真并行”（墙钟 2x+）；同时用 `autoSolo` 把“简单任务跑遍全链”压回 1 次（成本 5x）；而**深度推理/上下文强依赖**仍是单 Agent 的长板，项目组通过 P0-2 上下文注入尽可能弥补，但结构上无法与“同一条绳子”比肩。

