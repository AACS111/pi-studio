# 项目组新功能 · 测试复核报告（tester 验证）

> 角色：tester（测试复核）
> 复核对象：product 角色 `docs/team-analysis/product-ux-review.md` 提出的 bug 清单 B1–B10 + UX/P1–P6 建议。
> 方法：直接读取源码（TeamCreateDialog / TeamSettings / WorkflowEditor / TeamChat）+ 引擎测试实跑 + `tsc --noEmit`。
> 结论：**B1/B2 明确成立（需修复）；B3/B4/B5/B6/B8 成立（均低/中）；B9 部分成立（级联删边正常工作，仅 __end__ 补位观感小问题）；B7 不成立（有效防御，非 bug）。**

---

## 一、执行验证（实跑结果）

| 验证项 | 命令 | 结果 |
|--------|------|------|
| 引擎网关 | `node --import ./lib/team/node-loader.mjs --test lib/team/gateway.test.mjs` | ✅ 6/6 pass |
| 路由引擎 | `... runtime.test.mjs` | ✅ 5/5 pass |
| 流程引擎 | `... engine.test.mjs` | ✅ 13/13 pass |
| 生命周期 | `... lifecycle.test.mjs` | ✅ 5/5 pass |
| 存储 | `... store.test.mjs` | ✅ 8/8 pass |
| 类型检查 | `tsc --noEmit` | ✅ 无错误（重复字段不阻断编译，仅 UI 质量问题） |

> 引擎/运行时逻辑全部健康，**bug 集中在上层 UI 组件，不在执行引擎**。

---

## 二、Bug 复核结论

### ✅ 明确成立（建议优先修）

**B1（高｜约定违约）** `components/TeamCreateDialog.tsx`
- 证实：整组件 `position: fixed` 遮罩（inset:0）+ 固定 400px 卡片（`width:400,maxWidth:92vw`），无可拖动把手、无可缩放。点击遮罩直接 `onClose`。
- 违反 AGENTS.md「所有弹窗一律用 DraggableResizableModal」硬规。
- 期望：改用 DraggableResizableModal（convert 模式入口被 AppShell 复用 l.2204 调用）。

**B2（高｜字段重复/复制残留）** `components/TeamSettings.tsx`（角色展开面板）
- 证实：角色展开区出现 **两个 `maxOutputChars`（最大输出字符）** 字段：
  - grid2 #1（l.412-427）：`agentThinking`(推理级别) + `agentMaxOutput`(最大输出字符) ✅
  - grid2 #2（l.428-444）：`agentMaxTurns`(最大轮次) + **`agentMaxOutput`(最大输出字符，重复!)** ❌
- 修正 product 描述：被挤掉的不是一个「缺失字段」，而是**第二个 grid2 的第二个槽位被同一个字段错占**（maxTurns + 重复的 maxOutput）。当前面板无「最大输出」以外的第 4 个字段缺失——即面板实际字段：name/emoji/role/model/prompt/tools/skill/routing/context/thinking/maxTurns/maxOutput**(×2)**。
- 期望：`maxOutputChars` 全局唯一；第二个 grid2 次位改为应有的字段（若设计只有这些，则删掉重复并减少一行）。

### ✅ 成立（均真实存在，严重度低/中）

**B3（中｜弹窗规范违约）** `components/WorkflowEditor.tsx` EdgeEditPanel（l.540）
- 证实：`position:absolute; top:8; right:8; width:240`，固定在画布右上角，**不可拖动、不可缩放**，240px 内事件/优先级/启用挤一行。覆盖右上角节点。不满足 DraggableResizableModal。
- 期望：minipopover 就近锚定或至少可拖动、宽度可调、不遮挡被编辑边。

**B4（低｜代码异味）** `components/TeamSettings.tsx` l.48
- 证实：`useState<Tab>(initialAgentId ? "agents" : "agents")` 两分支同为 `"agents"`，恒真，条件冗余。`initialAgentId` 真正生效处是 l.55 `expanded`。
- 期望：删除条件（直接 `"agents"`），或明确意图。

**B5（低｜命中区与视觉不一致）** `components/TeamChat.tsx` Header 角色 chips
- 证实：外层 `<span>` `cursor:pointer` + `title`（视觉像可点），但 `onClick` 只挂在内层 span 上 → 命中区仅文本宽度，且无 hover 反馈。
- 期望：点击热区与视觉一致、加 hover 态。

**B6（低｜消息排序无稳定副键）** `components/TeamChat.tsx` `allMessages`
- 证实：注入 `task-user-*` / `task-user-active-*` 后仅按 `createdAt` 排序（`sort((a,b)=>a.createdAt-b.createdAt)`），时间戳相等时顺序不稳定（理论边界）。
- 期望：加稳定副键（id/sequence）。

**B8（低｜受控 select 反模式）** `components/TeamSettings.tsx` 模板导入
- 证实：`<select value="">` + onChange 里手动 `e.target.value=""`。
- 期望：用受控 state（`templateSel`）恢复。

### ⚠️ 部分成立（级联删边实际正常，仅 `__end__` 观感）

**B9（低｜修正后降级）** `components/WorkflowEditor.tsx`
- 证实：`handleNodesDelete`（l.-）对节点/网关委托 `onDeleteAgent/onDeleteGateway`；TeamSettings 的 `deleteAgent`/`deleteGateway` **已级联 filter transitions**，且 `updateTeam` 同一轮同时更新 agents+transitions → React 单次渲染，**不会闪**，边随节点同步消失。级联删边**工作正常**。
- 仅存观感：删除 `__end__` 后本地补回用 `nodeInitPos("__end__")`（可能走 savedPos 或 auto 布局），且删除触发 ReactFlow re-fit 视角轻微跳动。属 cosmetic。
- 期望：确认补回位置与删除前一致即可。

### ❌ 不成立（非 bug，有效防御）

**B7（撤销）** `components/TeamCreateDialog.tsx` `onCreated(sessionId ?? data.team.sessionId)`
- 反证：`lib/team/types.ts` l.125 `TeamDef.sessionId` 存在，且 `lib/team/lifecycle.ts` `convertTeam` 返回 `{ team: TeamDef, importedCount }`。即使 `sessionId` prop 未传，`data.team.sessionId` 也能正确回退到会话 id。该写法是**有效的防御性回退**，非空转。
- 结论：**不是 bug**。可保留。

---

## 三、UX/P1–P6 状态复核

- **P1（输入两态割裂）**：源码证实 composer + 框内内联 ⏹ 已合并（符合记忆「单组合输入框」）；但 **steer 仍是运行中才出现的第二个独立小输入** `composerSteer`（TeamChat l.516-537）。剩余改善确认存在，非 bug。
- **P2（红字告警非 toast）**：`postError` 用底部 `styles.error`（红底长条）、TeamSettings `error` 底部红字常驻。确认存在。
- **P3（角色字段无分组）**：TeamSettings agents 展开区 10+ 字段平铺无分节。确认存在（B2 根因即手写 JSX 无字段元数据表）。
- **P4（空态引导不足）**：空团队仅一句 `emptyHint`；空画布无连线引导占位。确认存在。
- **P5（边浮层）**：实为 B3。
- **P6（运行轨迹回放）**：仅 hops/rework/execs 数字 + ⏳。确认存在，属提档项。

---

## 四、优先级（供实施方）

1. **B1 弹窗硬规 + B2 字段重复**（明确 bug，最快见效）
2. **P3 角色面板分组**（消除 B2 根因）
3. **P1 合并 steer 到主输入**（体验单点）
4. **B3/P5 边浮层**
5. **P2 toast + P4 空态引导**
6. **P6 轨迹回放 / 画布图例**（提档）

---

*产物路径：`docs/team-analysis/tester-review.md`。由 tester 基于源码 + 引擎测试实跑复核输出。*