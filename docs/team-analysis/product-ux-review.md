# Pi Studio 项目组新功能 · 产品/设计师视角评审报告

> 角色：product（产品经理，负责 UX / 美观性 / 方案设计）
> 范围：重点评审新增的「项目组（Team）」相关功能：TeamChat、TeamSettings、WorkflowEditor、TeamCreateDialog、TeamTemplatesPanel、TeamTemplateEditor、角色库。
> 原则：不改代码（纯评审），产出「优化建议 + bug 清单 + 验收标准」，供 tester 复核 bug、供后续实现。

---

## 一、结论摘要（给组长的 30 秒版）

**整体观感偏「工具型可用但不够好看」**：功能深度足够（角色/工作流/网关/模板/运行监控都已铺开），但存在三类问题——

1. **一致性违约（明确 bug）**：`TeamCreateDialog.tsx` 仍是纯 `fixed` 遮罩弹窗（不可拖动、不可缩放），违反 AGENTS.md「所有弹窗一律用 DraggableResizableModal」硬约束。
2. **明显的编辑复制错误（明确 bug）**：`TeamSettings.tsx` 角色展开面板里 `agentMaxOutput`（最大输出字符）字段重复渲染了两遍（同一字段出现两次，第二个 grid2 块把另一个应有的字段挤掉，疑是「最大输出」复制粘贴残留）。
3. **体验/美观性可提升点**：输入框两态（composer / steer）并存造成操作割裂；错误提示用「红字警告」而非内联 toast；角色展开面板字段堆积无分组、无折叠纵深；EdgeEditPanel 是固定在画布右上角的小浮层（覆盖节点、尺寸过小、不可拖动，仍不满足弹窗规范）；空态与首次引导不足。

---

## 二、明确 Bug 清单（建议 tester 优先复核）

| # | 位置 | 描述 | 严重度 | 期望验收 |
|---|------|------|--------|----------|
| B1 | `components/TeamCreateDialog.tsx` | 整组件用 `position: fixed` 遮罩 + 固定 400px 卡片。**不可拖动、不可缩放**，违反 AGENTS.md 弹窗硬规（所有弹窗一律 DraggableResizableModal）。| 高（约定违约） | 改为 DraggableResizableModal（convert 模式入口），可拖动+可缩放 |
| B2 | `components/TeamSettings.tsx` agents 展开面板 | `agentMaxOutput`（最大输出字符）Field 在第 5 个 grid2 与第 6 个 grid2 **重复出现两次**；第二个 grid2 本应承载其它字段（疑为「最大重试/最大轮次」类）却被同一字段占位。属编辑复制残留。| 中 | 展开面板里每个字段唯一；补齐被挤掉的字段 |
| B3 | `components/WorkflowEditor.tsx` `EdgeEditPanel` | 双击边弹出的编辑面板用 `position: absolute; top:8; right:8; width:240`，固定在画布右上角：**会覆盖右上角节点、面板过小（240px，systemPrompt/优先级挤一行）、不可拖动不可缩放**，同样不满足 DraggableResizableModal 规范。| 中 | 就近浮层至少可拖动、宽度可伸缩，或改用迷你 popover 且不遮挡当前正在编辑的边 |
| B4 | `components/TeamSettings.tsx` | `tab` 初始化 `useState<Tab>(initialAgentId ? "agents" : "agents")`：**两个分支都是 "agents"**，条件表达式恒真——`initialAgentId` 分支意图可能是默认定位到其它 tab，但现在无论有没有 initialAgentId 都落到 agents。逻辑冗余/失效。| 低（功能上无害，代码异味） | 若 no-op 则删除条件；如需 initialAgentId 定位角色应保留 agents 但明确意图 |
| B5 | `components/TeamChat.tsx` | Header 角色 chips：`<span style={{...cursor:"pointer"}}>` 外壳可点（title 提示编辑），但点击监听只挂在**内层 span**上。外层只是视觉上像可点，命中区窄；且无 hover 反馈。可用性细节。| 低 | 点击热区与视觉一致、有 hover 态 |
| B6 | `components/TeamChat.tsx` | 消息合并 `allMessages` 把 run 的 task 注入成 `task-user-*` 消息再按 `createdAt` 排序——**同一 run 的 task 与后续 agent 消息若时间戳相等会出现乱序**；且注入仅靠 id 前缀匹配，不够稳。| 低 | 排序加稳定副键（id/sequence），task 注入与 run 的 messages 强关联 |
| B7 | `components/TeamCreateDialog.tsx` | `handleSubmit` 成功后 `onCreated(sessionId ?? data.team.sessionId)`——如果 `sessionId` prop 为空且后端返回结构不符会拿到 undefined，onCreated 空转。| 低 | 落位校验后端字段 `team.sessionId` 兜底 |
| B8 | `components/TeamSettings.tsx` | 保存按钮 `disabled={saving || errors.length > 0}`：只要有 **warning**（非 error）仍可保存，逻辑正确；但同一 tab 内「工作流 tab 首行=模板导入」下拉 `value=""` 且 `onChange` 后手动 `e.target.value = ""`——React 受控 select 用 `value=""` 再手动改 DOM value 会触发「受控组件 value 警告/重置闪烁」。| 低 | 模板选中恢复用受控 state（如 `templateSel`）而非直接改 `.value` |
| B9 | `components/WorkflowEditor.tsx` | Delete/Backspace 删除 `__end__` 时本地补回，但补回位置用 `nodeInitPos("__end__")`（可能靠 savedPos/auto 布局）——删除后重排位置可能与原不同；且删除其它节点时 **级联删边只发生在上层（TeamSettings 的 onDeleteAgent），WorkflowEditor 内未做本地边级联**，依赖父级回调时序。| 低 | 删除后画布立即一致（节点+边同步消失），不闪 |
| B10 | `components/TeamChat.tsx` | `handleSteer` 失败仅 `setPostError("steer failed")`，未透出真实原因；steer 输入只有运行中才显示（`{running && ...}`），停止后 steer 内容仍可输但发送无反馈。| 低 | 失败透出真实 message；steer 仅在 running 时可用 |

> 说明：以上均可被 tester 复核。核心高优先是 **B1（弹窗硬规违约）** 与 **B2（字段重复/复制残留）**。

---

## 三、UX 体验优化建议（按优先级）

### P1｜输入区两态割裂（TeamChat）
现状：`composer`（发任务文本框）与 `composerSteer`（运行中的 steer 小输入）是两个独立控件，运行中时 composer 下的发送按钮变 ⏹、又额外冒出一行 steer 小输入。用户切换「发任务 ↔ 中途纠偏」时要看两处。

建议：合并为**单一组合输入框**（与普通会话一致）：运行时文本框即用于 steer（占位符切「向当前角色发送指示…」），⏹ 内联按钮保持；任务发起 = 非运行态。减少控件数、降低认知负担。
验收：非运行态输入=发任务；运行态同一输入框=steer；⏹ 始终在框内右下。

### P2｜错误/反馈用「内联 toast」而非红字告警
现状：`postError` / TeamSettings `error` 用顶部/底部一行红字常驻，占空间且不显眼。

建议：改为轻量 toast（右上角浮出、3-5s 自动消失），或至少视觉上更「操作反馈」而非「静态告警」。状态成功（保存成功 `✓ saved`）也应短暂反馈后淡出。
验收：操作成功/失败均有即时浮层反馈，且不阻塞继续操作。

### P3｜角色展开面板字段堆积无分组（TeamSettings agents tab）
现状：角色展开后一屏平铺 10 个 Field（名字/emoji/职责/模型/提示词/工具/skill/路由/上下文/思考/最大输出×2…），无分节，滚动长、信息密度高。

建议：按语义分为三组折叠卡片——**基本信息**（名/emoji/职责/入口标记）、**能力配置**（模型/工具/skill/思考级别/最大输出）、**协作策略**（路由/上下文范围/最大轮次/重试）。默认只展开「基本信息+能力」，策略收起。同时修复 B2 字段重复。
验收：角色配置有清晰层级，常用字段一眼可见，高级字段折叠可展开。

### P4｜空态与首次引导（TeamChat / TeamSettings）
现状：空团队消息区只有一句 `emptyHint` 文案；工作流 tab 空态只有一行提示。新用户不知道「先加角色→连边→发任务」。

建议：首个角色自动展开并配「下一步」引导条；空工作流时画布中央给**虚线占位 + 文案「拖右侧圆点连线，或点左侧 ＋角色/＋网关」**；运行完成后给一条总结性质的 system 消息。让 3 步「配置角色→画工作流→发任务」可视化引导。
验收：新团队 30 秒内能看懂下一步，空画布不再空白。

### P5｜Edge 双击编辑浮层（WorkflowEditor / B3）
建议：双击边弹出的编辑面板用 **mini popover 就近定位（锚定被编辑边中点附近）**，宽度可调且可拖动，绝不遮挡正在编辑的边本身；或复用 DraggableResizableModal 的轻量版。优先级/启用等高频项放首屏。
验收：编辑某条边时该边始终可见；浮层可移动不遮挡节点。

### P6｜运行状态「可视化编排回放」
现状：TeamChat 底部只给 `hops / rework / execs` 三个数字 + ⏳「谁在思考」。用户对「现在跑到哪个角色、返工了几次、卡在哪」缺乏全局感。

建议：把运行历史做成**轻量编组列表**（折叠式）：每次 run 收成一个卡片，内含节点序列执行轨迹（leader→...→tester #2），返工（rework）的边/pair 高亮显示，可一键展开看对应 agent 消息。与流程图（WorkflowEditor）呼应——运行中可在流程图上高亮当前执行节点（若成本可控）。
验收：用户能看到「当前在哪、执行了几跳、是否在返工、历史 run 可展开回溯」。

---

## 四、UI 美观性优化建议

1. **视觉层级**：Header 里 badge / 角色 chips / routing mode chip / ⚙️ 挤在一行，12 像素字号堆叠，主次不分。建议：角色 chips 置顶主导航层、routing/⚙️ 降为次级、行加 2px 间距与更轻的背景（`bg-soft` 弱化），提升呼吸感。
2. **消息气泡统一**：`imported`（历史导入）气泡与 agent 气泡结构重复且固定 🤖，建议并入 agent 样式并在时间轴加「来自历史会话」分隔标签，避免视觉噪音。
3. **WorkflowEditor 画布**：节点 168×54 偏小、Palette 76px 紧凑合理，但网关菱形 + 名称 + 类型三行堆叠在 54px 里显得挤。建议：减小 emoji/符号占比、提升 name 字重、role 副文字 `text-dim` 且 ≤20 字截断（已有截断），统一圆角/阴影 token，让画布更干净。
4. **空态插画/图标**：空态用 emoji `👥` 略随意，可换成产品化的简笔队形插画或渐变卡片 + 一句引导，提升「设计感」。
5. **色彩一致**：`GATEWAY_STYLE` 四色（排他蓝/并行绿/包容橙/汇聚紫）已在画布与列表复用，色彩体系成立；但 `entryBadge`、`_end__` 虚线、`rework` 红边的语义色未出现在任何图例。建议在画布角部加**一行迷你图例**（▶入口 / ⏹结束 / 红边返工 / × 排他…）。
6. **响应式**：角色字段 grid2（1fr 1fr）在窄面板下会挤压输入；建议 `minmax` 或窄屏单列。

---

## 五、架构/逻辑层面的产品视角观察（供 leader 汇总）

- **受控 select 反模式**（B8）：模板下拉 `value=""` + 手动 reset DOM value，属经典 React 反模式，建议统一改受控 state。
- **重复字段**（B2）说明角色表单字段尚无「字段元数据表」，全靠手写 JSX，才容易复制出重复。可抽象为「字段定义数组 + 分组渲染」，顺带解决 P3 分层。
- **Task 注入消息**（B6）用 id 前缀 + 时间排序，耦合 run 内部结构；建议 run 的 message 流在事件源里就带 `runId` 并在投影层统一注入，避免 UI 层拼装。
- **校验与保存**：TeamSettings「errors>0 禁保存」正确；但**保存成功只 `onSaved` 回调拉取**，未在运行时校验校验结果与运行中配置快照不一致的情况（运行改配置应提示「需重启 run 生效」）。建议加提示。

---

## 六、验收标准（供 tester / 下一角色）

1. **B1**：TeamCreateDialog（convert 模式）打开后顶栏可拖动、四角/四边可缩放、不占全屏 —— 通过 DraggableResizableModal 复用。
2. **B2**：TeamSettings 任一角色展开，`最大输出字符` 字段全局只出现一次；被挤掉字段已补齐（预期应为某「协作/轮次」字段）。
3. **P3**：角色展开按「基本信息/能力/策略」分组折叠，默认展开前两组，策略收起可展开。
4. **P1**：TeamChat 输入框非运行态=发任务，运行态=steer，⏹ 始终内联；无第二套输入控件。
5. **P2**：发任务/保存/steer 的操作反馈均为即时浮层 toast，成功后淡出，不阻塞。
6. **P4**：新空团队空态有引导文案/占位，空画布有「如何连线」提示。
7. **P5**：双击边编辑浮层不遮挡被编辑边，可拖动、可调宽。
8. 复核清单：B1–B10 逐项核验（真实交互：convert/创建、展开角色、连边、编辑边、删除节点、跑 run、steer、cancel）。

---

## 七、优先级排序（给实施方的建议顺序）

1. **B1 弹窗硬规 + B2 字段重复**（明确 bug，最快见效，先修）
2. **P3 角色面板分组**（顺带重排字段、消除 B2 根因）
3. **P1 输入框合并**（体验最大单点）
4. **P2 toast 反馈**（低成本提升整体质感）
5. **P4 空态引导 + P5 边浮层**
6. **P6 运行轨迹回放 / 画布图例**（提档项）

---

*由 product 角色基于源码静态评审输出；bug 清单需 tester 复核后汇总给 leader。产物路径：`docs/team-analysis/product-ux-review.md`。*