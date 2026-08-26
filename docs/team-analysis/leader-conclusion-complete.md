# 我的项目（Pi Studio）对比「官方 MetaGPT + OpenHarness」缺陷与不足 · 组长最终汇总

> 任务：拿本项目（`@aacs111/pi-studio` v0.8.6，多 Agent 实现在 `lib/team/**`）
> 与 **官方 MetaGPT**（`https://github.com/FoundationAgents/MetaGPT`）和 **OpenHarness**（`https://github.com/HKUDS/OpenHarness`）做对比，找出缺陷和不足。
> 角色分工：researcher 产出官方 MetaGPT 增量对比矩阵 → tester 逐项源码真实验证（PASS，10 项判定全部属实）→ 组长（本条）合并两参考结论向用户汇总收尾。
> 证据底座：`docs/team-analysis/pi-vs-references-matrix.md`（OpenHarness/MetaGPTTest 矩阵）、`leader-conclusion-vs-references.md`（已有 OpenHarness 汇总）、`metagpt-official-matrix.md`（官方 MetaGPT 增量矩阵）、`metagpt-official-tester-report.md`（官方 MetaGPT 验证报告）。

---

## 〇、TL;DR（30 秒结论）

**核心引擎（可视化工作流 / 真并行 / 结构化裁决 / 审批闸门 / 审计溯源 / 技能系统）Pi 已达头部水平；真正的"缺陷与不足"集中在 4 层生产级能力缺口 + 若干体验/安全项。**

本次任务与上次相比的**关键新增**：上一轮只对比过 **OpenHarness** 与**教学版 MetaGPTTest**（NanGePlus），**官方 FoundationAgents/MetaGPT 从未对比过** —— 这是本轮的真实缺口，已逐源码补齐并经 tester 验证全部属实。

两个参考的结论方向（均已核实）：
- **OpenHarness**（成熟 Harness）：我方短板主要在 **worktree 隔离 / 跨 run 团队记忆 / 完整 DAG 调度 / secret 扫描 / dry-run**。
- **官方 MetaGPT**（生产级框架）：我方短板集中在 **自我进化 / 知识复用(RAG/经验池) / 心智搜索(ToT) / 运行期动态性 / 预算熔断**。
- 两者高度互补，合并后即完整缺陷清单。

---

## 一、缺陷与不足（合并两参考，按优先级）

### P0 能力缺口（结构性，多 Agent 规模化生产的关键能力）

| # | 缺陷 | 对比来源 | 我方现状（源码核实） | 说明 |
|---|---|---|---|---|
| 1 | **任务依赖 DAG 调度** | 官方 MetaGPT `planner.py` + `thinking_command.py:23 dependent_task_ids`（原生 DAG）；OpenHarness 任务列表驱动 | `types.ts:242 dependsOn` 仅注释「Phase 2 未接线」；`runtime.ts`/`engine.ts` 零消费，仅 `context.ts:62` 透出为显示文本 | **任务依赖是主流多 agent 标配，Pi 只透出不调度**。= 待办 P1-3。⚠️ 与本项目多 Agent 执行是**同一个缺陷**（官方 MetaGPT 证明 Pi 并非不想做，而是该做未做） |
| 2 | **跨 run 共享团队记忆** | OpenHarness `memory/team.py` MEMORY.md；官方 MetaGPT `LongTermMemory/MemoryStorage`（FAISS+embedding） | `lib/team/` 无大写 `MEMORY` 库（grep 命中仅为 Auto-Compaction 的本地持久化，非团队记忆） | 每次 run 从零开始，长协作各 run 失忆。= 待办 P2-2 |
| 3 | **RAG / 向量库（6 种后端）** | 官方 MetaGPT `document_store/`：chromadb/faiss/lancedb/milvus/qdrant + `rag/engines` | `lib/team/` 无任何 vector/RAG | 团队上下文黑板无知识检索底座 |
| 4 | **经验池（Experience Pool）** | 官方 MetaGPT `exp_pool/`（decorator/manager/schema，QueryType EXACT/SEMANTIC 语义复用 + scorers/judges） | `lib/team/` 零命中 | 无法沉淀/复用历史优秀解题经验，每次 run 从零开始 |
| 5 | **预算熔断（CostManager）** | 官方 MetaGPT `cost_manager.py:31 max_budget` + `team.py:133 _check_balance` 每轮检查抛 `NoMoneyException` | `types.ts:188 tokensUsed/:223 cost` 仅成本**统计上报**，无预算上限/熔断 | 成本不可控，无"资金耗尽即停"熔断 |
| 6 | **ToT + 动态计划编辑** | 官方 MetaGPT `strategy/tot.py`（Tree-of-Thoughts）+ `thinking_command.py` Command APPEND/RESET/REPLACE/FINISH（运行中动态改计划） | `WorkflowEditor` 静态编排，无 ToT 结构化思考、无运行期命令式改计划 | 计划一旦跑起来不能动态增/改/替换任务 |

### P0 并发安全（OpenHarness）
| # | 缺陷 | 对比来源 | 我方现状 | 说明 |
|---|---|---|---|---|
| 7 | **Git worktree 隔离** | OpenHarness `swarm/worktree.py` | `AgentDef.workspace` `types.ts:25` 仅注释「Phase 2 接 worktree」 | 多角色并发写同一仓库无进程隔离，易冲突。= 待办 P2-1 |

### P1 健壮性/安全
| # | 缺陷 | 对比来源 | 我方现状 | 说明 |
|---|---|---|---|---|
| 8 | **secret 扫描防护** | OpenHarness `memory/team.py` 正则拦截 key/AWS/token；官方 MetaGPT 安全实践 | `lib/team/context.ts` grep `secret|AKIA|api_key` 零命中 | 写共享黑板/记忆前无密钥拦截 |
| 9 | **dry-run 安全预览 + PreToolUse 拦截** | OpenHarness `permissions/hooks` | executor 仅订阅**读取型** `tool_execution_start` 转发，无「事前预览要调哪些工具+阻断危险调用」的 pre-hook | 无法在真实执行前预览/拦截 |
| 10 | **自动工具推荐** | 官方 MetaGPT `tools/tool_recommend.py:195 BM25ToolRecommender` | Pi `toolNames` 静态清单 | 不能依据任务上下文自动推荐工具 |
| 11 | **RoleZero 自我进化体** | 官方 MetaGPT `roles/di/role_zero.py`（组合 exp_pool+长期记忆+planner+工具推荐） | Pi agent 静态定义 | 无"越跑越强"的自我进化 agent |

### P2 体验/能力
| # | 缺陷 | 对比来源 | 我方现状 | 说明 |
|---|---|---|---|---|
| 12 | **完成 run 无法回看执行分解** | OpenHarness/通用可观测 | `executionsOverview` 仅 `running` 时渲染 | 跑完逐角色 token/产物/耗时不可回查 |
| 13 | **异常全量团队快照 + git 归档** | 官方 MetaGPT `serialize_decorator`（异常/中断也落盘）+ `env.archive(auto_archive)` | Pi 有 Event Sourcing（sessions/<id>.jsonl）但无「crash 全量快照 + 跑完 git 归档」等价物 | ◐ 半差：有持久化，缺异常时全量落盘+归档 |
| 14 | **agent 间定向 mailbox（P2P）** | OpenHarness `swarm/mailbox.py` | 仅黑板广播，无点对点私信投递 | ◐ 通信靠黑板广播 |
| 15 | **IM channel 接入**（Feishu/DingTalk/Slack） | OpenHarness channels | 无（本地桌面工具） | 若定位本地桌面可降级为非需求 |
| 16 | **角色独立 timeoutMs 无 UI 入口** | 本方能力未暴露 | executor 已读 `agent.timeoutMs`，TeamSettings 无字段 | 功能存在但 UI 无入口 |
| 17 | **WorkflowEditor 整块硬编码中文，无 i18n** | 本方违约 | 组件无 `useI18n`，`GATEWAY_STYLE.label` 中文 | 违反 i18n 约定 |

---

## 二、已覆盖项（对标确认，非缺陷——避免误报）

- ✅ **编排建模**：Transition + GatewayDef(exclusive/parallel/inclusive/merge) + BPMN 可视化，远超 MetaGPT 线性 SOP。
- ✅ **真并行（P0-3）**：parallel/inclusive 网关 `Promise.all` 并发 + merge join（已量化 ≈2.3x 墙钟加速），OpenHarness/MetaGPT 均无同级可视化并行网关。
- ✅ **human-in-loop 审批闸门（P1-2）**：waiting_approval + approve/reject。
- ✅ **结构化裁决（P1-1）**：verdictGuard 优先于 keyword。
- ✅ **expected_output 验收标准、事件溯源持久化、多 provider + per-agent model、Auto-Compaction、skill 复用（对应官方 skill_loader）、熔断 maxHops/maxRework、cost 统计上报**。
- ✅ **审批闸门 vs OpenHarness 差异**：方向不同——我方是"agent 产出→用户审批"，OpenHarness 是"worker→leader 工具权限审批"，后者细化项已并入 P1-9。

---

## 三、最关键的一句话（给用户）

> **Pi Studio 的多 Agent 骨架与速度准确性已是头部水平；短板不在核心引擎，而在"多 Agent 做规模化生产任务"的三类生产级配套：① 任务依赖 DAG 调度 + worktree 隔离（并行安全）、② 知识/经验复用（RAG + 经验池 + 跨 run 团队记忆）、③ 预算熔断与运行期动态性（ToT/动态改计划）。**
> 官方 MetaGPT 与 OpenHarness 恰好分别补齐了这三类的"工程细节"与"自我进化"维度，是明确可对照补齐的路线图。

---

## 四、建议落地顺序（每项改动过 tsc --noEmit + lint）

1. **P0-1 任务依赖 DAG 调度（P1-3）**——官方 `dependent_task_ids` 是标配、Pi 已有 `dependsOn` 字段 + `context.ts` DAG 黑板 + P0-3 就绪集并行，**收益最明确、改动可控**，应最先补。
2. **P0-7 Git worktree 隔离（P2-1）**——`AgentDef.workspace.mode` 已预留，接真实 git worktree。
3. **P0-2 跨 run 团队记忆（P2-2）**——仿 OpenHarness `team/MEMORY.md`，读时注入 / 结束时写；**写前加 secret 扫描**（一并解决 P1-8）。
4. **P0-5 预算熔断**——`TeamDef` 加 `maxBudget`，运行时 `_check_balance` 抛熔断（仿 CostManager）。
5. **P1-10/11 自动工具推荐 + RoleZero 自我进化**——可作上层可选能力，不必阻塞。
6. **P2-12/16/17 补齐体验项**：run 回看、timeoutMs 入口、i18n。

---

## 五、核验证据链（避免口头有实现）

- 本轮官方 MetaGPT 10 项判定经 tester 源码逐项实测 **PASS 属实**（见 `metagpt-official-tester-report.md`）。
- OpenHarness/MetaGPTTest 已覆盖项与缺口自上一轮核实（`leader-conclusion-vs-references.md` §四）。
- 两轮结论交叉印证、无冲突：官方 MetaGPT 新增补充了 OpenHarness 未突出的「经验池/RAG/预算熔断/ToT/RoleZero/自动工具推荐」，其余与已有结论一致。

---

## 六、参考文档
- 官方 MetaGPT 增量矩阵：`docs/team-analysis/metagpt-official-matrix.md`
- 官方 MetaGPT 验证报告：`docs/team-analysis/metagpt-official-tester-report.md`
- OpenHarness/MetaGPTTest 功能矩阵：`docs/team-analysis/pi-vs-references-matrix.md`
- OpenHarness 结论汇总：`docs/team-analysis/leader-conclusion-vs-references.md`

*汇总产出：`docs/team-analysis/leader-conclusion-complete.md`（本文件）*