# 我的项目（Pi Studio）对比 MetaGPTTest / OpenHarness 的缺陷与不足 · 组长最终汇总

> 任务：拿本项目与 `https://github.com/NanGePlus/MetaGPTTest`、`https://github.com/HKUDS/OpenHarness/tree/main` 做对比，找出缺陷和不足。
> 角色分工：组长（本条）基于已有成果（`reference-baseline.md` 基线 + `pi-vs-references-matrix.md` 功能矩阵）
> 逐项在最新源码核实后汇总。核实方式见矩阵文档第四部分；本文仅列**结论 + 核验证据**。
> 我方对象：`@aacs111/pi-studio` v0.8.6，多 Agent 实现在 `lib/team/**`（Event Sourcing 运行时 + 工作流网关 + TeamChat）。

---

## 〇、TL;DR（30 秒结论）

**引擎能力我方显著领先（BPMN 可视化工作流 / 真并行 / 结构化裁决 / 审批闸门 / 审计溯源均已超过两参考），
真正"缺陷与不足"集中在 5 个结构性缺口 + 若干安全加固 / 体验项。**

两参考性质差异：
- **MetaGPTTest** 本质是**教学示例**（B站配套 python 脚本），无生产级能力。我方在编排建模、可视化、熔断、裁决上**全面超过**，无我方独缺项。
- **OpenHarness** 是**成熟 Harness**（工具/权限/记忆/多 agent 基建齐全），是真正值得补差的**对标对象**。
  **我方 5 大结构性缺陷几乎全部来自 OpenHarness 已具备而本方未实现的能力。**

| 分级 | 缺陷/不足 | 对比来源 | 我方现状（源码核实） | 优先级 |
|---|---|---|---|---|
| **P0 结构缺口** | ① worktree 隔离（跨 agent 并发写同一仓库无隔离） | OpenHarness `swarm/worktree.py` | `lib/team/types.ts:25` 仅注释 "Phase 2" | 高（并发风险） |
| | ② 跨 run 共享团队记忆（MEMORY 库） | OpenHarness `memory/team.py` | `lib/team/` 无任何 persist/MEMORY | 高（长协作失忆） |
| | ③ 任务依赖 DAG 调度（dependsOn 可执行化） | OpenHarness/MetaGPT 任务列表驱动 | `types.ts:242` 注释 "Phase 2"，context.ts 仅透出展示 | 高（真并行只到网关级） |
| **P1 安全加固** | ④ secret 扫描防护（写共享上下文前拦截 key/密码） | OpenHarness `memory/team.py` 正则拦截 | `lib/team/context.ts` 无拦截 | 中（黑板上可能泄漏密钥） |
| | ⑤ dry-run 安全预览 + PreToolUse 拦截语义 | OpenHarness `permissions/hooks` | 仅有读取型 `tool_execution_start` 转发，无"事前预览/阻断" | 中 |
| **P2 体验/能力** | ⑥ 完成 run 无法回看执行分解（逐角色消耗/产物/耗时） | OpenHarness/通用可观测 | TeamChat `executionsOverview` 仅 `running` 时渲染 | 中 |
| | ⑦ agent 间定向 mailbox（P2P 私信）缺失 | OpenHarness `swarm/mailbox.py` | 仅黑板广播，无点对点投递 | 低 |
| | ⑧ 经济/预算上限模型缺失 | MetaGPT 经济 / OpenHarness | 只有成本统计无预算熔断 | 低 |
| | ⑨ IM channel 接入（Feishu/DingTalk/Slack） | OpenHarness channels | 无（本地桌面工具，可降级为非需求） | 低 |
| | ⑩ 角色独立 timeoutMs 无 UI 入口 | 本方能力未暴露 | executor 已读取 `agent.timeoutMs`，TeamSettings 无字段 | 中 |
| | ⑪ WorkflowEditor 整块硬编码中文，无 i18n | 本方违约 | 组件无 `useI18n`，`GATEWAY_STYLE.label` 中文 | 中 |

---

## 一、已覆盖项（对标确认，非缺陷——避免误报为"不足"）

矩阵逐项核实后，我方**不弱于甚至超过**两参考的能力：

- ✅ **编排建模**：`Transition + GatewayDef(exclusive/parallel/inclusive/merge)` + BPMN 式可视化工作流，远超 MetaGPT 的线性 SOP。
- ✅ **熔断与迭代**：`maxHops + maxReworkRounds`（四保险丝）替代 MetaGPT 固定 `n_round` 空转。
- ✅ **真并行（P0-3）**：parallel/inclusive 网关分支 `Promise.all` 并发 + merge join（已量化 2.25–2.4x 墙钟加速），OpenHarness/MetaGPT 均无同级的可视化并行网关。
- ✅ **human-in-loop 审批闸门（P1-2）**：转换边 `waiting_approval` + approve/reject（等价 OpenHarness worker→leader 审批、LangGraph interrupt 精神）。
- ✅ **结构化裁决（P1-1）**：`verdictGuard` 优先于 keyword 路由，治 keyword 赌错。
- ✅ **expected_output 验收标准（P0-4）**：对齐 CrewAI；两参考无。
- ✅ **事件溯源持久化**：`TeamRun` 事件流 + 每角色独立会话 jsonl，可审计/回放，强于两参考 JSON 落盘。
- ✅ **多 provider + per-agent model**：比 OpenHarness 的 provider 切换更细粒度。
- ✅ **skill 复用、Auto-Compaction、团队任务黑板**：与 OpenHarness 对齐。
- ⚠️ **语义持平但方向不同**：审批闸门方向是"agent 产出→用户审批"，OpenHarness 是"worker→leader 工具权限审批"——我方缺"agent 间工具权限审批"这一细分（已并入 P1-⑤/审批方向待补）。

---

## 二、最关键的一句话（给用户的判断）

> **我方已经把"多 Agent 的骨架和速度准确性"做到了头部水平，短板不在核心引擎，而在 OpenHarness 已率先落地的三类生产级配套：①并行写仓库的 worktree 隔离、②跨 run 的团队记忆、③基于任务依赖图的完整 DAG 调度。**
> 这 3 项是"多 Agent 真正做规模化生产任务"的最后一公里。MetaGPTTest 无参考价值（教学样例），OpenHarness 是主要对标。

---

## 三、建议落地顺序（每项改动须过 tsc --noEmit + lint）

1. **P0-① worktree 隔离（P2-1）**：`AgentDef.workspace.mode="team"|"isolated"` 已预留在 `types.ts:25`，接真实 git worktree（对齐 OpenHarness `swarm/worktree.py`），改源码时用 `ELECTRON_RUN_AS_NODE=1` 模拟子进程验证。
2. **P0-② 跨 run 团队记忆（P2-2）**：仿 OpenHarness `project/team/MEMORY.md`，在 `lib/team/context.ts` 注入 + 启动时读、结束时写；**写前加 secret 扫描**（一并解决 P1-④）。
3. **P0-③ 完整 DAG 调度（P1-3）**：把 `TeamTask.dependsOn` 从"上下文透出"升级为「就绪集调度」——复用已就绪的 P0-3 波次并行（ready-set 已建），让"下游任务依赖上游任务完成"成为可执行约束，而非 workflow 接力。
4. **P1-⑥ run 回看**：让 `executionsOverview` 在非 running 也渲染（历史折叠卡片），补逐角色 token/产物/耗时。
5. **P2-⑩⑪**：TeamSettings 补 `timeoutMs` 字段；WorkflowEditor 补 i18n（`GATEWAY_STYLE.label` 收敛为翻译映射）。

---

## 四、核验证据（防"口头有实现"，本条已逐行确认）

- `types.ts:25` `mode: "team" | "isolated" // 默认 team；Phase 2 接 worktree` —— **仅注释未接线**。
- `types.ts:242` `dependsOn? // Phase 2 并行调度使用` —— 仅 `context.ts:62` taskDagLines 透出为文本，**无调度接入运行循环**。
- `lib/team/` `grep -i "MEMORY"` == 0（大写 MEMORY 库零匹配）—— 无跨 run 共享记忆。
  > 研究员复核注：若用宽松正则 `grep -ri "MEMORY|persist|long_term"` 会命中 4 行，但全部来自
  > `compaction-*.test.mjs` 的 `isPersisted/persisted`（Auto-Compaction 设置的本地持久化），
  > **与团队记忆无关**；真正证明「无跨 run 团队 MEMORY 库」的是大写 `MEMORY` 单独查询为 0。
  > 故「无团队记忆」结论成立，仅 grep 写法需精确（区分 Compaction 持久化 vs 团队共享记忆）。
- `lib/team/context.ts` `grep -i "secret|AKIA|api_key"` == **零匹配** —— 无 secret 扫描。
- `components/TeamChat.tsx` `executionsOverview`(l.344) 仅在 l.519 `{running && …}` 内渲染 —— 跑完不可回看。
- `components/TeamSettings.tsx` `grep timeoutMs` == 零匹配 —— executor 已读取但 UI 无入口。
- `components/WorkflowEditor.tsx` `grep useI18n` == 0，`GATEWAY_STYLE.label` 硬编码"排他/并发/汇聚" —— 无 i18n。

---

## 五、参考依据

- 基线提取：`docs/team-analysis/reference-baseline.md`
- 功能矩阵（逐项 ✅/❌/◐ 证据底座）：`docs/team-analysis/pi-vs-references-matrix.md`
- 我方引擎方法论与落地进度：`docs/team-analysis/single-vs-team-solve.md`
- 上方核验为组长本条基于最新源码直读确认，与矩阵结论一致，无修订冲突。

*汇总产出：`docs/team-analysis/leader-conclusion-vs-references.md`*