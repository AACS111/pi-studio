# 官方 MetaGPT（FoundationAgents/MetaGPT）⇄ Pi Studio lib/team 增量对比矩阵

> 角色：研究员（researcher）
> 任务：用户要求拿本项目与官方 MetaGPT（`https://github.com/FoundationAgents/MetaGPT`）和 OpenHarness 做对比，找出缺陷不足。
> 本文是**官方 MetaGPT 的增量对比**（此前已对比过 OpenHarness 与教学版 MetaGPTTest —— 见 `docs/team-analysis/pi-vs-references-matrix.md`、`reference-baseline.md`，可复用）。
> 官方 MetaGPT 从未被对比过，是本次任务的真实缺口。
> 官方 MetaGPT 已克隆于 `C:/Users/zheng/AppData/Local/Temp/MetaGPT`（890 个 .py，生产级框架）。
> 已通过**源码逐行核实**（read/grep 命令输出为据）。

---

## 一、官方 MetaGPT 核心增量能力（源码证据）

| 能力 | 源码位置（我实际读过） | 说明 | Pi lib/team 现状 | 判定 |
|---|---|---|---|---|
| **统一成本预算熔断（CostManager）** | `metagpt/utils/cost_manager.py` | `CostManager.max_budget` + `Team.invest()` 注入投资额；`Team._check_balance()` 当 `total_cost >= max_budget` 时抛 `NoMoneyException`（`utils/common.py` 的 `NoMoneyException` 异常类），`Team.run()` 每轮检查 | `types.ts:188 tokensUsed`、`:223 cost` 仅有**成本统计上报**，**无预算上限/熔断**概念 | ❌ **缺失（P0）** |
| **Team 全量序列化 + 自动归档** | `metagpt/team.py` `serialize()`/`deserialize()`；`utils/common.py:675 serialize_decorator`；`environment/base_env.py:244 archive()` | `team.json` 落盘 `SERDESER_PATH/team`；`serialize_decorator` 在**异常/KeyboardInterrupt 时也序列化**（crash 可恢复）；`auto_archive` 用 `GitRepository.archive()` 归档跑完项目 | Pi 持久化是 `sessions/<id>.jsonl` + TeamDef meta（Event Sources），但**无「异常时全量落盘+git 归档」**的完整团队状态快照 | ◐ 有持久化，缺 crash 全量快照+git 归档 |
| **经验池（Experience Pool）** | `metagpt/exp_pool/`（decorator `exp_cache`、manager、schema `Experience/Metric/Trajectory`、scorers、perfect_judges、serializers、context_builders） | **语义检索过往优秀经验**（`QueryType=EXACT/SEMANTIC`）复用，评分+判别 + 打分，经验类型 SUCCESS/FAILURE/INSIGHT | Grep `lib/team/`：`embedding|vector|rag|exp_pool|experience|longterm` **0 命中** | ❌ **缺失（P0）** |
| **RAG / 向量数据库（6 种）** | `metagpt/document_store/`：`chromadb_store` `faiss_store` `lancedb_store` `milvus_store` `qdrant_store`；`metagpt/rag/engines/`（simple+flare） | 多后端向量检索，供记忆/经验/文档问答复用 | Pi `lib/team/` 无任何 vector/RAG | ❌ **缺失（P0）** |
| **Planner + Tree of Thoughts（ToT）** | `metagpt/strategy/`：`planner.py`、`tot.py`、`base.py`（ThoughtNode/ThoughtTree）、`solver.py` | **plan-and-act 模式**：任务计划含 `dependent_task_ids`（**任务依赖 DAG**！）+ `task_type` 注入人类先验指导；`tot.py` 实现 Tree-of-Thoughts 搜索求解 | Pi 的 `TeamTask.dependsOn`（`types.ts:242`）标注 **Phase 2**，**未接线调度**（已验证 tester 将核实）；**无 ToT** 结构化思考搜索 | ❌ **任务依赖 DAG + ToT 均缺失** |
| **动态计划编辑命令** | `metagpt/strategy/thinking_command.py` | `Command.APPEND_TASK/RESET_TASK/REPLACE_TASK/FINISH_CURRENT_TASK`，角色**运行中动态增/改/重置/替换任务**并级联重置依赖任务 | Pi 工作流/计划在 `WorkflowEditor` 静态编排，**运行中无动态改计划命令** | ❌ 缺失 |
| **RoleZero 自我进化体** | `metagpt/roles/di/role_zero.py` | 组合 exp_pool + `RoleZeroLongTermMemory` + Planner + `BM25ToolRecommender`（`tools/tool_recommend.py:195`） | Pi agent 均为**静态定义**（templates/library），**无自我进化**机制 | ❌ 缺失 |
| **长期记忆 LongTermMemory / MemoryStorage** | `metagpt/memory/longterm_memory.py`、`memory_storage.py`（**FAISS 作 ANN + embedding**）、`brain_memory.py`、`role_zero_memory.py` | 角色级**跨 run 持久记忆**，启动时 recover、变化时 update | 对应 Pi 待办 **P2-2 跨 run 记忆未实现**（已确认 grep `long_term|persist` 命中仅为 Auto-Compaction 持久化，非团队共享记忆） | ❌ **缺失（P2-2，已有待办）** |
| **工具推荐 ToolRecommender** | `metagpt/tools/tool_recommend.py:54` `class ToolRecommender`、`BM25ToolRecommender:195` | 依据任务上下文**自动推荐**该用的工具 | Pi 是 `toolNames` 静态清单，**无自动工具推荐** | ❌ 缺失 |
| **技能加载 Skill** | `metagpt/learn/skill_loader.py` + `metagpt/skills/` | skill 按需加载 | Pi 已有 `skillIds`（`types.ts:23,53`）+ `.agents/skills/*`（本会话即用 browser-control/sheet-edit） | ✅ 已实现 |
| **环境/角色生态（生产级）** | `metagpt/roles/`：architect/engineer/product_manager/project_manager/qa_engineer/data_interpreter/swe_agent/team_leader/researcher/searcher/customer_service/sales/teacher/tutorial_assistant... | 大量生产级 role + 多环境（software/android/minecraft/werewolf/stanford_town） | Pi 有 `templates.ts` + solver + `library.ts` 模板角色库，但规模远小于官方 | ◐ 部分（角色生态规模小） |

---

## 二、结论：官方 MetaGPT 独有而 Pi 缺失的「缺陷与不足」

相比官方 MetaGPT，Pi `lib/team` 的核心缺口集中在 **「自我进化 / 知识复用 / 心智搜索」三层** 与 **「运行期动态性」**：

### P0 能力缺口（本轮官方 MetaGPT 对比新增确认）
1. **❌ 任务依赖 DAG 调度** —— 官方 MetaGPT `Planner` 的 `dependent_task_ids` 原生支持任务依赖 DAG，而 Pi `types.ts:242 dependsOn` 标注 Phase 2 未接线。**这正是共享任务列表里 P1-3 待办**（团队在跑依赖，官方已实现）。
2. **❌ 经验池（Experience Pool）** —— 官方可语义复用「历史优秀经验」（exp_cache/scorer/judge）。Pi 每次 run 都从零开始，多 run 不沉淀解题经验。**P0.**
3. **❌ RAG / 向量库（6 种后端）** —— 官方有 document_store（chromadb/faiss/lancedb/milvus/qdrant）+ rag/engines，Pi `lib/team/` 零命中。团队上下文黑板无知识检索底座。
4. **❌ 预算熔断（CostManager max_budget）** —— 官方 `Team.invest()` 设投资额上限 + `_check_balance` 抛 `NoMoneyException` 熔断。Pi 只上报 `cost` 统计，**无预算上限/成本熔断**。
5. **❌ ToT（Tree of Thoughts）+ 动态计划编辑** —— 官方 `strategy/tot.py` 与 `thinking_command.py`（append/reset/replace/finish 命令，运行中动态改计划）。Pi 计划静态，无 ToT 结构化搜索、无运行期命令式改计划。

### P1 体验/健壮性缺口
6. **❌ 跨 run 长期记忆** —— 官方 LongTermMemory/MemoryStorage（FAISS 向量）。= Pi 待办 P2-2 未实现（已复验）。
7. **❌ 自动工具推荐** —— 官方 BM25ToolRecommender 依据任务推工具；Pi toolNames 静态。
8. **❌ RoleZero 自我进化** —— 官方有把 exp_pool+长期记忆+planner+工具推荐组合成自我进化 agent；Pi 无此机制。
9. **◐ 异常时全量团队快照+git 归档** —— 官方 serialize_decorator 在异常/中断时也落盘 + auto_archive git 归档；Pi 有 Event Sourcing 持久化但无「crash 全量快照 + 跑完 git 归档」的等价物。

### 已覆盖项（非缺陷，官方 MetaGPT 有但 Pi 已具备）
- ✅ 技能系统（Pi skillIds + .agents/skills 对应官方 skill_loader）。
- ✅ 角色/模板库（Pi library+templates+solver 对应官方 roles，广度不及但够用）。
- ✅ 成本统计上报（Pi cost/tokens 上报，只是缺上限熔断）。

---

## 三、依赖证据清单（可复现，供 tester 核实）

| 断言 | 验证命令/路径 |
|---|---|
| cost_manager 有 max_budget + NoMoneyException 熔断 | `read C:/Users/zheng/AppData/Local/Temp/MetaGPT/metagpt/utils/cost_manager.py`；`common.py` `NoMoneyException` |
| Team.invest/_check_balance 在 run 每轮检查 | `read .../metagpt/team.py`（`invest()` `_check_balance()` `run()` loop） |
| Team serialize/deserialize + serialize_decorator | `read .../metagpt/team.py`（`serialize/deserialize`）；`common.py:675 serialize_decorator` |
| auto_archive 用 git | `environment/base_env.py:244 archive()` → `GitRepository.archive()` |
| exp_pool 存在 | `ls .../metagpt/exp_pool/`（decorator/manager/schema/scorers/perfect_judges/serializers） |
| document_store 6 向量库 | `ls .../metagpt/document_store/`（chromadb/faiss/lancedb/milvus/qdrant + base） |
| planner 的 dependent_task_ids / DAG | `read .../metagpt/strategy/thinking_command.py`（APPEND_TASK signature 含 dependent_task_ids） |
| tot.py 存在 | `ls .../metagpt/strategy/tot.py` + `base.py` ThoughtTree |
| LongTermMemory + MemoryStorage(FAISS) | `read .../metagpt/memory/longterm_memory.py`、`memory_storage.py` |
| BM25ToolRecommender | `grep BM25ToolRecommender .../metagpt/tools/tool_recommend.py`（:195） |
| Pi 无 RAG/经验池/预算熔断 | `grep -rni 'embedding|vector|rag|exp_pool|experience|budget|max_budget' lib/team/` → 除 `getInternalDir` 外 0 命中 |
| Pi dependsOn 未接线（Phase 2） | `grep -n 'dependsOn' lib/team/types.ts` → `:242  // Phase 2` |

---

## 四、风险与建议

**风险：**
- 官方 MetaGPT 是 **Python 生产框架** 且严重依赖向量库/embedding（llama-index/faiss），把这套搬到 TS 的 `lib/team/` 成本高，需评估是否真需要。
- 任务依赖 DAG 调度（P1-3）因「高重构风险」被反复标记为待办 —— 但官方 `dependent_task_ids` 证明它是主流多 agent 标配，Pi 若不实现，对比中会持续作为缺陷出现。

**建议下一步（tester 核实）：**
1. 逐项在 `lib/team/**` + `components/**` 源码核实上述「缺陷」真伪（防口头有实现）。
2. 优先级建议：**P0 先补「任务依赖 DAG 调度」**（官方已实现、Pi 待办已记录、收益明确）；「经验池/RAG/预算熔断」为大改，可按需立项。
3. 汇总时与已有 OpenHarness/MetaGPTTest 对比矩阵合并，形成完整缺陷清单。

**关键取舍已记录：** 官方 MetaGPT 的增量缺口集中在「自我进化/知识复用/心智搜索」与「运行期动态性」，这是 Pi 相对官方最主要的不平衡点。