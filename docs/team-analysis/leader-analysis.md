# 项目组（Multi-Agent Team）问题与 UI 优化 · 组长汇总分析报告

> 角色：组长（leader）
> 任务：分析当前项目组还有哪些问题、UI 上可优化的地方。
> 方法：**对照当前源码逐项核实**（未把历史评审结论照搬），并补充既往评审未覆盖的新发现。
> 核验方式：直接读 `components/TeamChat.tsx` / `TeamSettings.tsx` / `WorkflowEditor.tsx` / `TeamCreateDialog.tsx` / `hooks/useTeamRun.ts` + `lib/team/*`。
> 关联：`docs/team-analysis/product-ux-review.md`（product 评审 B1–B10/P1–P6）、`tester-review.md`（tester 复核）、`tester-save-close.md`（保存不关闭已修复）。

---

## 〇、结论摘要（给用户的 30 秒版）

**功能引擎健康、执行逻辑全部正常，问题集中在「上层 UI」与「配置能力缺口」。**

- **既往评审的明确 bug 几乎全部仍存在**：B1（弹窗硬规）、B2（字段重复）、B3（边浮层）、B4（三元冗余）、B5（点击热区）、B6（排序无副键）、B8（受控 select 反模式）——我在当前代码里全部核实到，**无一修复**。
- **部分优化已落地**：模板导入下拉已改为「始终加载」（空团队也可用）；TeamChat 发送按钮已并入文本框内联（不再有独立按钮行）。
- **新增问题（本次核实发现，既往评审未覆盖）**：
  1. **WorkflowEditor 整块硬编码中文，无 i18n**（Palette 标签 / 网关类型名 / 边浮层 / 顶栏提示 / 全屏按钮）。团队配置已是 en/zh-CN，唯独画布是纯中文，破坏国际化一致性。
  2. **按角色 `timeoutMs` 可生效但 UI 无入口**——executor.ts 实际读取它，TeamSettings 却无该字段，只能设团队级 maxRunMinutes。
  3. **已完成/失败/取消的 run 无法回看执行分解**——`executionsOverview`（角色卡）只在 `running` 时渲染，跑完后只剩一行数字，逐角色 token/产物/耗时看不到。
  4. **模板导入会静默覆盖现有团队配置且无确认**——在已配置好的团队上点「应用模板」会把 agents/transitions/gateways/entryAgentId/四保险全部替换，无二次确认，易损坏用户配置。
  5. **空团队时「工作流」Tab 画布被整体隐藏**——`{!canvasExpanded && team.agents.length > 0 && <WorkflowEditor/>}`，无角色时看不到画布，也不提供从该 Tab 添加第一个角色的入口，只能去「角色」Tab 或靠模板导入。空态无任何连线/上手引导。

---

## 一、既往评审问题 · 当前源码核实状态

> 结论：**除 2 项外，其余在最新代码中仍原样存在。** 下面附行号取证。

### ✅ 仍未修复（明确 bug，建议优先）

| # | 位置 | 现状 | 取证 |
|---|------|------|------|
| B1 | `TeamCreateDialog.tsx` | 仍 `position: fixed; inset:0` 遮罩 + 固定 `width:400` 卡片，**不可拖动、不可缩放**，违反 AGENTS.md 弹窗硬规（所有弹窗一律 DraggableResizableModal）。 | l.47-72；注意：目前仅 convert 模式使用（创建已改侧栏 POST），影响面收窄但规范违约仍在。 |
| B2 | `TeamSettings.tsx` agents 展开面板 | `maxOutputChars`（最大输出字符）**重复出现两次**：first grid2（thinking+maxOutput），second grid2（maxTurns+maxOutput 重复）。 | l.412-444：第二个 grid2 次位仍是 `agentMaxOutput`，应为其它字段或删掉。 |
| B3 | `WorkflowEditor.tsx` `EdgeEditPanel` | 仍 `position:absolute; top:8; right:8; width:240` 固定右上角，**不可拖动、不可缩放**，覆盖右上角节点。 | l.541-549。 |
| B4 | `TeamSettings.tsx` | `useState<Tab>(initialAgentId ? "agents" : "agents")` 三元恒 `"agents"`，冗余。 | l.48。 |
| B5 | `TeamChat.tsx` Header 角色 chips | 外层 span `cursor:pointer` 但 `onClick` 只在内层 span；命中区仅文本宽，无 hover。 | l.245-260。 |
| B6 | `TeamChat.tsx` `allMessages` | 注入 task-user 消息后仅按 `createdAt` 排序，无稳定副键，时间戳相等时乱序（边界）。 | l.139-161。 |
| B8 | `TeamSettings.tsx` | **两处**受控 select 反模式：角色库下拉 & 模板导入下拉，均 `value=""` + onChange 里手动 `e.target.value=""`。 | 角色库 l.298-301；模板 l.545-546。 |
| B9 | `WorkflowEditor.tsx` | 级联删边实际正常（不闪）；仅删 `__end__` 补回位置可能与原不同 + ReactFlow re-fit 微跳（cosmetic）。 | 已降级，可不处理。 |

### ⚠️ 部分落地（非完整）

| # | 状态 | 说明 |
|---|------|------|
| P1 | 部分 | 发送/中断按钮已并入文本框内联（`composerRow`），但 **steer 仍是运行中出现的第二个独立 `<input>`（`composerSteer`）**，运行态双输入并存，未完全合并。 |
| P6 | 部分 | 运行中显示 ExecutionCard（角色卡），但 `executionsOverview` 仅在 `running` 时渲染，跑完不可回看（见新增问题 3）。 |
| 已修 | ✅ | 模板导入已改为始终加载（不再仅空团队显示）；保存不关闭已修复（tester-save-close 通过）。 |

### ❌ 过去复核结论（维持不变）

- **B7 非 bug**：`onCreated(sessionId ?? data.team.sessionId)` 是有效回退（`TeamDef.sessionId` 存在）。
- **B9 降级**：级联删边逻辑正常。

---

## 二、本次新增发现（组长核实，既往评审未覆盖）

### 新增 1｜WorkflowEditor 整块硬编码中文，无 i18n（一致性违约）
- 取证：`grep useI18n components/WorkflowEditor.tsx` → **无该 import**；组件内大量硬编码中文：`🤖 角色`、`排他/并行/包容/汇聚`（`GATEWAY_STYLE.label`，还被 TeamSettings 复用）、`⟳ 布局`、`✕ 退出全屏`、`⛶ 全屏`、`✏️ 边条件`、`事件/条件/关键词/判定规则/优先级/启用/删除此边`、顶栏提示 `拖节点移动 · … Delete 删除`。
- 影响：TeamSettings / TeamChat 均已走 `t()`，唯独画布是纯中文；切换 en 时画布仍中文，违反 i18n（en/zh-CN）约定。`GATEWAY_STYLE.label` 也被 TeamSettings 网关列表复用，需一并收敛。

### 新增 2｜`AgentDef.timeoutMs` 可生效但 UI 无入口（隐藏能力缺口）
- 取证：`lib/team/types.ts` l.39 定义 `timeoutMs`（单次执行超时，默认继承 maxRunMinutes）；`lib/team/executor.ts` l.67/139 **实际读取** `agent.timeoutMs ?? team.maxRunMinutes*60_000`。
- 但 `TeamSettings.tsx` 角色展开面板**没有任何该字段**；团队 Tab 仅暴露 `maxRunMinutes`。用户无法按角色单独设超时。同类未暴露：`handoffPolicy`（allowedTargets/allowSelfHandoff）、`workspace.mode`（isolated 属 Phase 2，可暂缓）。`sessionRetention`/`recentCount` 为预留，暂可不管。

### 新增 3｜已完成 run 无法回看执行分解（可见性缺口）
- 取证：`TeamChat.tsx` l.363 `executionsOverview` memo 生成，但只在 l.510 `{running && (...)}` 内渲染；跑完后只显示 `runFooter` 一行 `✅ completed ⚡ N tok · hops n / rework n / execs n`。
- 影响：用户想回看「这次 run 里开发 #2 用了多少 token/产出哪些文件/耗时多少」时，聊天区不给看；只能去文件里翻。属 P6（执行回放）的半成品。

### 新增 4｜模板导入静默覆盖团队配置，无确认（数据安全）
- 取证：`TeamSettings.tsx` 模板导入 onChange（l.504-536）`updateTeam({ agents: p.agents, transitions: p.transitions, gateways: p.gateways, nodePositions: p.nodePositions, entryAgentId, reworkEdges, defaultRoutingMode, maxHops, maxReworkRounds, maxRunMinutes, contextScope })`——整包覆盖现有团队，**无 confirm，且不保留 team.name**。
- 影响：用户在已配置团队上误点模板，会清掉自己排的角色/边/入口/四保险。建议加「将替换当前 N 个角色 / M 条边，确定？」二次确认；或在已有内容时禁用/提示。

### 新增 5｜空团队时「工作流」Tab 画布隐藏 + 无上手引导（空态）
- 取证：`TeamSettings.tsx` l.490 `{!canvasExpanded && team.agents.length > 0 && <WorkflowEditor/>}`；且该 Tab 无「添加第一个角色」按钮（只有角色库下拉 & `+ 添加角色`藏在 agents Tab）。
- 影响：新团队打开「工作流」看到的是模板下拉 + 网关空段 + 一行小字，无画布、无连线指引，不知下一步。建议空态给「① 从角色库/＋添加角色 → ② 拖右侧圆点连线 → ③ 发任务」的可视引导，或至少放一个「+ 添加角色」占位节点进画布。

---

## 三、UI 优化优先级清单（给实施方）

> 按「见效快 / 风险低 / 提升质感」排序；同段位内先修 bug 再做体验。

### P0 —— 明确 bug（约定违约 / 复制残留，先修，最快见效）
1. **B1** `TeamCreateDialog` → 改用 `DraggableResizableModal`（convert 入口复用），可拖动可缩放。
2. **B2** 删除第二个重复的 `agentMaxOutput`；若有更合理字段（如 `timeoutMs`，见新增 2）则顺带补上。**同时**把角色表单抽象为「字段元数据数组 + 分组渲染」，根治手写 JSX 复制错位（顺带解决 P3 + 新增 2）。

### P1 —— 体验最大单点
3. **P1 合并 steer 到主输入**：把 `composerSteer` 并入主 textarea，非运行态=发任务、运行态=steer（占位符切换），⏹/发送始终内联；删除独立第二输入行。
4. **新增 4 模板导入确认**：既有角色/边时弹确认或禁用，防误覆盖。
5. **B3/P5 边浮层**：`EdgeEditPanel` 改为 mini popover 就近锚定（不遮挡被编辑边、可拖动/调宽）或复用 DraggableResizableModal 轻量版；编辑某条边时该边始终可见。

### P2 —— 一致性 + 可见性
6. **新增 1 WorkflowEditor i18n**：给 Palette/网关类型/边浮层/顶栏/全屏按钮补 `t()`；`GATEWAY_STYLE.label` 改为 i18n key 或提供翻译映射。这是跨语言一致性的硬性欠账。
7. **新增 3 已完成 run 回看**：`executionsOverview` 在非 running 也渲染（或提供 run 历史展开看逐角色执行分解），让过去 run 的 token/产物/耗时可见。

### P3 —— 质感 / 空态 / 细节
8. **新增 5 空团队引导**：空画布给连线占位 + 3 步引导；空态用产品化插画替换 emoji。
9. **P2 toast 反馈**：`postError`/`TeamSettings.error` 从「底部红字常驻」改轻量 toast（右上浮出、自动消失），成功也短暂 `✓`。
10. **P3 角色面板分组**：按「基本信息 / 能力配置 / 协作策略」折叠分组（顺带补 `routingPolicy` 中文下拉项文案）。已归入 P0-2 的字段化改造。
11. **美化**：Header 角色 chips/模式/⚙️ 分层弱化（视觉层级）；WorkflowEditor 节点字号/间距/圆角统一 token（当前节点 168×54 偏挤）；`imported` 气泡加「来自历史会话」分隔标签；画布角部加迷你图例（▶入口 / ⏹结束 / 红边返工 / 网关四色）。

---

## 四、建议实施方案（顺序依赖）

1. **字段化重构**（角色表单）→ 一次解决 B2 + P3 + 新增 2，是最高杠杆。
2. **弹窗规范**：B1（TeamCreateDialog）+ B3（边浮层）→ 统一 DraggableResizableModal / mini popover。
3. **输入区合并 + 模板确认**：P1 + 新增 4。
4. **i18n 补齐**：新增 1（WorkflowEditor）。
5. **可见性**：新增 3（run 回看）+ P2 toast + 新增 5（空态）。
6. **提档**：P5/P6（运行轨迹回放 / 画布图例）。

> 注：所有改动须过 `tsc --noEmit` + `npm run lint`；涉及 i18n 需保证 zh/en key 数量一致（当前团队 key 已 290+）。

---

## 五、待决 / 建议拍板（供组长后续决策）

- **B2 第二个槽位补什么**：建议补 `timeoutMs`（单次执行超时），因为 executor 已读取它，是最「该露脸却缺席」的字段；`routingPolicy` 下拉里的策略文案也需中文说明以降低理解成本。
- **模板导入行为**：建议「有内容则二次确认」，而非直接覆盖。
- **run 回看形态**：建议做成「运行历史折叠列表」，每 run 卡片内展逐角色执行分解（区别于运行中的实时 ExecutionCard）。

---

*产物路径：`docs/team-analysis/leader-analysis.md`。由组长基于当前源码逐项核实 + 取舍既有评审后汇总。待实施方接单后将上述 P0–P3 转为修复/优化任务。*
