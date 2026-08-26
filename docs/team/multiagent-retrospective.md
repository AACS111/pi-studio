# 多 Agent 项目组失败复盘 + 架构优化（为何不如单会话）

> 场景：用户让「项目组」（多 Agent：leader/product/developer/tester）做「参考 DeepSeek Harness 官网加动态背景」，
> 项目组跑很久、反复输出、超时失败；随后用户改用**当前普通会话（单个 Agent）**，反而又快又好地完成了。
> 本文分析原因、对比开源方案、说明已落地的架构/执行逻辑优化。

---

## 一、现象（用户观察到、与代码一致的）

| 现象 | 是否属实 | 代码层面根因 |
|------|---------|-------------|
| 项目组执行很久（30min+）才结束/超时 | ✅ | 默认 `software-dev` 模板是**串行链**，且存在**无限回环**（见 §二.1），直到 `maxHops=30` / `maxRunMinutes` 才兜底 |
| 没有并行执行 | ✅ | `software-dev` 无任何网关（gateway），是 `leader→product→developer→tester` 纯串行；只有 `solver` 模板才有 parallel 分叉 |
| leader 输出了很多次 | ✅ | `t1-leader-product` 是 `mode:"always"` —— leader 只要不吐「总结完成/最终结论」这类**精确关键词**，每次执行完都会再被送回 product，整条链重跑一遍 |
| 执行很混乱 | ✅ | 每个角色一个**全新 pi 会话**（重复重建上下文/暖机），靠**keyword 猜路由**交接，缺少真正共享的工作中间态 |

---

## 二、根因分析

### 1. 路由依赖「关键词猜命」→ 无限回环（核心 bug）
`software-dev` 里，leader 结束的唯一可靠触发是 `t0-leader-end`：**输出须命中** `["总结完成","任务完成","最终结论",…]`。
LLM 几乎不会一行不差地吐出这些串。于是 `t1-leader-product`（`priority:0, mode:"always"`）**永远兜底命中**，
把 leader 再次送回 product → developer → tester → …→ leader → product → … 形成 4 节点死循环，仅被 `maxHops/timeout` 掐断。
这就是「跑很久、leader 反复输出、混乱」的**单点根因**。

### 2. 默认模板是串行，不是并行
- `software-dev`：`leader→product→developer→tester`，**没有任何网关**，天然串行。
- 只有 `solver` 模板用了 `parallel` 网关（leader→[研究员/开发/文档]三分支）。

### 3. 上下文/产物在角色间「重建 + 摘要」，不是共享黑板
- 每个角色是独立 pi 会话，context 由 `buildContext` 重建（摘要 + trace 指针）。
- 角色不共享一个可变的工作目录状态：developer 改了代码，tester 只能看摘要/自己 read trace，**没有「最终 diff 直接验收」的强闭环**。

### 4. 验证是「LLM 评 LLM」，非「跑测试验真」
- tester 角色靠输出里是否出现「通过/问题/bug」关键词（或 record_decision 的 verdict）来决定 pass/fail。
- 这是**自我认可式**专家评审，没有真正运行单测/编译/截图验证，容易误判，导致 developer/tester 反复拉锯。

### 5. 编排入口角色被「锁死」成只派活
- orchestrated 模式下 leader 的工具白名单只剩 `ls/find`，不能读业务代码、不能自行验证。
- 一旦下游角色掉链子，leader 无从兜底，只能继续空转。

---

## 三、为什么单个会话反而更快更好

单个 Agent（就是用户当前普通会话）本质是 **SWE-agent / OpenHands 式紧密 act→observe→refine 循环**：
- 有**完整持久上下文**：读文件 → 改 → `tsc`/`lint` → headless 截图 → 复现 → 再改，一气呵成；
- 没有**路由/关键词/交接**开销，没有「重建上下文 + 暖机」的重复成本；
- 验证是**真实验证**（跑 tsc/eslint、headless 截图肉眼确认），不是 LLM 自我评审。

而多 Agent 团队把这种紧密循环**拆成一堆一次性 LLM 调用**，靠脆弱的 keyword 交接，且验证不可靠。
对「加一个动态背景」这种**单点、紧密耦合的功能**，团队是净劣于单个 Agent 的。

> 关键结论：多 Agent 协作**不是万能更强**，它更适合「可拆成多个**相对独立**子任务 / 需要跨领域专长 / 需要互相制衡」的大型任务；
> 对「单个 Agent 就能闭环、且验证路径明确」的功能任务，团队反而引入路由开销与失配风险。

---

## 四、参考开源方案及启示

| 开源 | 核心思想 | 本项目实况 / 启示 |
|------|---------|------------------|
| **MetaGPT** | 角色按 SOP + **结构化产物**（PRD/设计/代码），共享 `Message Pool` 黑板，异步 publish→subscribe | 本项目有 `team_record_decision`/`artifacts`，但路由仍偏 keyword。启示：**把交接信息结构化，别赌关键词** |
| **AutoGen** | `GroupChatManager` 用 LLM **决定下一个发言者**，共享对话历史；有 `max_round` | 本项目按图路由。启示：**用结构化信号（verdict/executionSeq）替代 keyword 猜命** |
| **LangGraph** | **显式共享 State**，节点读写 state；条件边基于 state；`Send` 并行分支；checkpoint 持久化 | 本项目已有 merge/approval 借鉴点。启示：**用执行序号只在首次放行入口，靠状态而非文本定终态** |
| **CrewAI** | 任务带 `expected_output`，顺序/层级流程 | 本项目 `agent.expectation` 已实现。启示：**明确每角色验收标准，避免自由发挥** |
| **SWE-agent / OpenHands** | 单 Agent 紧密 agentic 循环（工具+验证） | 这是「单会话更好」的本质，也说明**对单点功能应走 solo 路径** |

---

## 五、已落地的优化（本次代码改动）

### 1. 入口角色只放行一次 —— 修复无限回环（`types.ts`/`engine.ts`/`runtime.ts`/`templates.ts`）
- `Transition` 新增 **`onlyExecutionSeq?: number`**：仅当该角色的第 N 次执行时命中。
- `matchingTransitions` 按 `executionSeq` 过滤；`resolveRoute` 透传当前执行序号。
- 默认模板把入口（leader）的**派活边**标记为 `onlyExecutionSeq: 1`：
  - `software-dev` 的 `t1-leader-product`
  - `solver` 的 `s1-leader-split`
- **效果**：leader 第 1 次执行 → 派活；再次进入（seq≥2，如 tester 交回）→ 派活边不再命中；若又不吐关键词，则走「无路由 → 入口即完成」路径，**确定性结束**。
- **实测**：mock 让 leader#2 总结时不带任何关键词 → 执行序 `leader→product→developer→tester→leader`，leader 恰好 2 次，run `completed`（此前会无限循环/超时）。

### 2. 返工耗尽 → 收敛交付，而非硬失败（`runtime.ts`）
- 当命中返工边且 `reworkCount >= maxReworkRounds` 时，把本该返工的边**重定向回入口做一次收敛总结**，run 以 `completed`（best-effort）收尾，而不是 `max_rework` 失败。
- **实测**：dev↔tester 反复失败 3 次后收敛到 leader 总结，`reworkCount=3`，run `completed`（此前会 hard fail）。
- 思想来源：MetaGPT「重试有上限、超限即收尾交付」。

### 3. solo 路径真正能干活 —— 修复「solo 只给 ls/find」bug（`executor.ts`）
- 此前`编排模式`把入口工具限制为 ls/find；但 **solo 模式**（简单任务）仍用了 `agent.toolNames`（leader 默认只剩 ls/find），导致 solo 路径**根本无法改代码**——即使判成 simple 也干不了活。
- 已改为：solo 模式入口角色给**全套工具** `[read,bash,edit,write,grep,find,ls]`（注释明确“solo 要亲自干活”）。

### 4. 任务复杂度默认偏向 solo（`task-classify.ts`）—— 站在用户角度
- 此前「宁可误判 complex」，导致**单点功能任务**（如“加一个动态背景”）也被拆成多角色接力 → 慢/丢上下文/超时。
- 改为：**仅明确「多模块/系统级/跨模块/搭平台/端到端」才 complex（走编排），其余一律 simple（solo）**。
- 因为 solo 路径现在有全套工具、能读改代码 + 真实验证，单点功能走 solo 又快又稳（正是单会话的体验）。

### 5. 全流程 E2E 回归测试（`lib/team/fullflow.test.mjs`）
- 覆盖两条路径：A) 用户“加动态背景”这种单点任务 → classifyTask=simple → 入口 solo 跑 1 次收尾；
  B) “多模块平台” → complex → solver 三分支**真并发**（时间重叠断言）→ merge → 测试 pass → 组长汇总（恰好 2 次）。
- 断言事件流含 `run_started/task_created/execution_started/execution_completed/handoff_requested/run_completed` 且 sequence 严格单调。

---

## 六、给你的落地建议

1. **按任务类型选模板**：
   - 可拆成多个**相对独立**子任务（调研/文档/多模块）→ 用 **`solver`（并行解题团队）**，能真并行 + 交叉验证。
   - **单点功能 / 需要紧密改代码验证**（如「加一个背景」）→ 用**单人 / solo 路径**更快更稳，别强行拆角色。
2. **给下游角色配 `expectation`（验收标准）**：让测试有明确 target，减少「LLM 评 LLM」空转。
3. **低可信度验证场景**：tester 应被授予**真实运行验证**的工具（跑测试/编译/截图），而不是只读文本下判断。
4. **风险 / 未实施项**（若继续深挖）：P1-3 完整 DAG 任务调度（`TeamTask.dependsOn`）、跨角色共享可变工作区、
   LLM judge 结构化、worktree 隔离。这些能进一步逼近「并行 + 真实验证」的 MetaGPT 目标，但改动面较大，建议专项推进。

---

## 七、一句话总结

> 多 Agent 团队跑得久、乱、失败，**不是「多 Agent 不如单 Agent」的宿命**，
> 而是当前实现踩了「**keyword 猜命路由 → 无限回环**」这个坑，且模板默认**串行**、验证靠 LLM 互评。
> 本次已用「**执行序号只放行入口一次 + 返工耗尽收敛**」把回环与硬失败修掉；
> 要真正发挥多 Agent 优势，应转向 **结构化交接（MetaGPT/AutoGen）+ 真实验证（SWE-agent）**，
> 并在「单点功能」时**主动走 solo 路径**。
