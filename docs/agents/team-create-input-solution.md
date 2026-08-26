# 项目组（多 Agent）执行模式 + 流程图画布显隐 方案 v3

> 按用户最新两步反馈定稿：
> 1. v2 去掉创建弹窗：创建项目组 = 普通会话一样直接开干，**默认「系统判断」**。
> 2. 输入框边加**执行模式选择器**：`系统判断 / 单独 / 串行 / 并行 / 自定义`。
>    - 系统判断 = 默认，按任务复杂度自动分流；
>    - 用户可从「单独 / 串行 / 并行」三档自己选执行策略；
>    - 自定义 = 必须自己画工作流，否则不能选。
> 3. **流程图画布只在「自定义」模式下出现**；其他模式（系统判断/单独/串行/并行）
>    下设置里**不显示流程图** —— 用户只有主动切到自定义才去画，平常不被工作流干扰。

---

## 一、最终形态（总览）

| 执行模式 | 含义 | 流程图 | 触发 | 底层映射 |
|---|---|---|---|---|
| **系统判断**（默认） | 按任务复杂度自动分流 | 不显示 | 发布时 `classifyTask`（simple→solo / complex→编排） | 现状路线 |
| **单独** | 单人闭环（=普通会话） | 不显示 | 强制 `solo`：leader 带全套工具单会话交付 | `shouldSolo`/simple 路径 |
| **串行** | 按角色串行接力 | 不显示 | 强制用 software-dev 串行工作流边（组长→产品→开发→测试+返工闭环） | `software-dev` 模板边 |
| **并行** | 并行分叉真并发 | 不显示 | 强制用 solver 并行网关 + 波次 `Promise.all` 真并发 | `solver` 模板平行网关 |
| **自定义** | 用户画的工作流 | **显示（唯一出现流程图）** | 用用户自定义 Template（角色+边+网关）执行 | 用户模板 |

核心约束：**只有 `executionMode === "custom"` 时，`TeamSettings` 才出现 workflow tab/流程图画布**；
非 custom 团队，设置里不渲染 `WorkflowEditor`（杜绝流程图干扰认知）。

---

## 二、根因 + 现状（已核实代码）

- `components/TeamChat.tsx` 输入区是自绘 textarea，无附件、无执行模式选项。
- `components/TeamSettings.tsx` 固定三个 tab（agents/workflow/team），`workflow` tab 始终渲染
  `WorkflowEditor` 流程图画布 —— 与用户「不自定义就不该看流程图」的诉求不符。
- `types.ts` `RoutingMode` = strict/hybrid/autonomous（路由判定方式，**另一维度**）；
  缺少顶层「执行模式」字段；`runtime.ts` 已有 `shouldSolo`（simple 强制 solo）与
  `gateway parallel` + 波次并发（`Promise.all`），solo/serial/parallel 三类能力**引擎均已实现**，
  缺的只是入口让用户一键选择，并把「执行模式」落到路由/流程选择。

---

## 三、改动清单

### 1. 类型层（`lib/team/types.ts`）
- `TeamDef` 新增 `executionMode?: "auto" | "solo" | "serial" | "parallel" | "custom"`（默认 `"auto"`）。
- 说明：`executionMode`（执行策略档位）与 `defaultRoutingMode`（strict/hybrid/autonomous 路由判定方式）
  独立；`auto` 沿用现状 classify 分流，其余档位覆盖该 team 的路由/流程选择。

### 2. 引擎层（`lib/team/registry.ts` / `lib/team/runtime.ts`）
- `startTeamRun(team, task, startAgentId?, executor?)` 读取 `team.executionMode`：
  - `auto` → 现状（`classifyTask`；simple→solo，complex→编排，按 `defaultRoutingMode` 路由）。
  - `solo` → 强制 `run.complexity = "simple"`（走 `shouldSolo` 单会话闭环）。
  - `serial` → 强制使用 software-dev 串行过渡边（若 team 未画，回退到 preset 边长）。
  - `parallel` → 强制使用 solver 平行网关（parallel + merge；若 team 未配，回退 preset 平行网关）。
  - `custom` → 使用用户自定义 Templates（`transitions`/`gateways` 全量跟随，`validate` 前置校验）。

> 落地为：`runtime.execute`/`pump` 里根据 `executionMode` 决定「是否 solo 降级」「用哪个工作流边/网关」，
> 把 preset（software-dev / solver）的 transitions/gateways 作为可回退的默认流程；`custom` 才用用户画的。

### 3. 前端输入区（`components/TeamChat.tsx`）
- composer 旁新增**执行模式选择器**（下拉，5 项：系统判断/单独/串行/并行/自定义），默认 `auto`。
- 选「自定义」时：若当前团队 `transitions` 为空（未画工作流）→ **禁用并提示**「请先在项目组设置→自定义 里画工作流」。
- 发送时把 `mode` 随任务传给 `startRun`。

### 4. 数据流（`hooks/useTeamRun.ts` + `app/api/teams/[sessionId]/runs/route.ts`）
- `startRun(task, mode?)` 增加参数；`POST /runs` body 增加 `mode?: ExecutionMode` → 透传给 `startTeamRun`。

### 5. 设置显隐（`components/TeamSettings.tsx`）
- tabs 里 **`workflow` tab 仅当 `team.executionMode === "custom"`时渲染**；
- 非 custom 时 workflow tab 不出现，`WorkflowEditor`/模板导入/网关列表均不展示；
- `focusIssue` 命中 transition 时：非 custom 不跳 workflow（改为提示「自定义模式下才可编辑工作流」）。

### 6. 模板/创建（`lib/team/templates.ts` + `components/AppShell.tsx`）
- 默认 `createTeamDef` 无参数时 `executionMode = "auto"`（系统判断）+ 预置 software-dev 角色与
  serial 默认边（但 workflow 画布不显示，除非切 custom）—— 一键创建即有完整多角色，却不在设置里
  干扰用户看流程图。
- `AppShell.onCreateTeam` 直接 `POST /api/teams` 不弹窗（保持"无脑创建"），带默认即可。

### 7. i18n（zh-CN / en）
- 补 `team.execMode.*`（4 档标签 + 自定义提示）、`team.execMode.selector` 等。

---

## 四、与工作流的兼容（回答「模板/角色是否冲突」）

- 模板与角色库**不冲突但有重叠**，收敛为：**「执行模式」是顶层属性，一次选择 = 决定"角色集 + 工作流"**。
  - 单独 ≈ 空模板（单 leader）；串行 ≈ software-dev；并行 ≈ solver；自定义 ≈ 用户模板。
  - 默认 auto → 由 classify 自动映射到单/多，因此**用户平常完全不用碰模板/角色/流程图**。
  - 只有想精细控制（custom）才进设置画流程；此时 workflow tab 才出现。符合「默认无脑、特定场景自定义」。

---

## 五、实施顺序（每步交付前验证）

1. **P0-1 类型 + 引擎映射**：`executionMode` 字段；runtime 按 auto/solo/serial/parallel/custom 选流程；
   `POST /runs` 透传 mode。验证：`tsc` + node 端到端断言——
   solo→run.complexity=simple 且入口单会话；serial→走串行边链；parallel→并行网关多分支；
   custom→用户 transitions。**全部不跑 `next build`。**
2. **P0-2 前端选择器**：`TeamChat` 输入框旁 5 项下拉 + custom 未画工作流时禁用提示；`startRun(mode)`。
3. **P0-3 设置显隐**：`TeamSettings` workflow tab 仅 custom 显示；focusIssue 非 custom 不跳工作流。
4. **回归**：tsc/eslint；headless/curl 验证 workflow tab 显隐（auto/solo/serial/parallel 不出现，
   custom 出现）；`custom` 无流程时选择器禁用并可打开设置去画。

---

## 六、给用户的一句话结论

创建项目组 = 普通会话一样直接输入开干（默认「系统判断」自动分流）；输入框边可一键切
「单独/串行/并行/自定义」。流程图只在你选「自定义」时才出现在设置里，其他模式全程不打扰；
所以平常完全不需要管模板/角色/工作流，只有想精细控制时才去画。这正是「默认无脑 + 特定场景自定义」的平衡。