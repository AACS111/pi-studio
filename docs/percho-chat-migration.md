# 将 pi-web 会话输出窗口替换为 percho 的方案与可行性分析

> 分析基准：percho @ github.com/Jaxton07/percho（2026-08-28 克隆，MIT 协议），pi-web/Pi Studio @ 0.8.6，pi SDK 双方均为 0.84.x（pi-web 0.84.2 / percho 0.84.3）。

---

## 一、percho 是什么

percho 是与本项目同源的**另一个 Pi coding agent 桌面 GUI**（Electron + React 19 + Tailwind 4 + Zustand），同样内嵌官方 SDK `@earendil-works/pi-coding-agent`（非 fork、非重新实现）。monorepo 三包：

| 包 | 职责 |
| --- | --- |
| `packages/shared` | IPC 契约 + **transcript 大脑**（事件流 reducer、UIMessage 模型、行分组 buildChatRows、历史回放映射） |
| `packages/backend` | 唯一 import Pi SDK 的地方（Electron main 进程跑 AgentSession） |
| `packages/desktop` | 渲染层：chat 组件群、composer、会话 tab、设置、UI 插件槽位 |

## 二、percho「会话输出窗口」的架构（要替换的部分）

数据链路分三层，**每层都可独立移植**：

```
SDK AgentSessionEvent 流（与 pi-web 同源！）
   ↓ ① reduceEvent()：563 行纯函数 reducer（shared/src/transcript/reducer.ts）
SessionTranscriptState：UIMessage[]（user/assistant/error/system/image/subagent）
                       + StreamingState（流式累积，稳定 id 防重挂载）
                       + phase / agentActive / retrying / todos / followUpQueue
   ↓ ② buildChatRows()：258 行纯函数行分组（shared/src/transcript/chat-rows.ts）
行模型：user → MetaGroup（思考+工具折叠组，text 为边界）→ assistant 正文
        → turnDiff chip（每轮文件变更）→ subagent 卡 → 错误卡
   ↓ ③ JSX 渲染（desktop chat 组件群，共 ~1900 行，全部小而独立）
MessageList（760px 居中列 + ResizeObserver 底部跟随 + 回底按钮）
 ├ MessageItem → UserMessage / AssistantMessage / MetaGroup（折叠工具组）
 │   └ ToolCallCard（单行渐变截断摘要，展开看全参+输出+unified diff）
 │   └ Markdown = markstream-react（grapheme 级平滑流式输出 + monaco 代码块 + thinking-orbs 思考动画）
 ├ ErrorNote / RetryNote（统一错误卡 + SDK 自动重试状态行）
 ├ TurnDiffChip / SubagentRunCard / TodoPanel / SystemMessage（压缩状态）
 └ UI 插件槽位（ToolCallCard/SubagentCard/TodoPanel 可被插件替换，自带 fallback）
```

**percho 相比 pi-web 现有输出窗口的核心体验差异**：

| 维度 | pi-web 现状（ChatWindow+MessageView ~2900 行） | percho |
| --- | --- | --- |
| 流式正文 | 消息快照整体替换，MarkdownBody 重渲染 | markstream 平滑打字机流，固化瞬间不跳变（流式/固化共用同一 React key） |
| 工具调用 | 每条 toolResult 独立大卡片 | 折叠组：思考+工具收进一组圆点行，单行摘要渐变截断，时序保真（text→tool 交错用 blockIndex 锚定） |
| 错误呈现 | notice 通知条 | 会话内错误卡（重试轮合并成一张）+ 自动重试状态行 + 一键重试 |
| 历史回放 | role 直渲染 | 文本/思考/工具预拆分 + entryId 配对（fork/撤回可精确锚定） |
| 底部跟随 | 手写 | RO 贴底 + 高度收缩不误释放 + 折叠展开自动脱离 |
| 每轮文件变更 | ChangedFilesCard（已有） | TurnDiffChip 行内 chip（更轻） |

## 三、可行性分析

### 3.1 有利条件（为什么可行）

1. **同一 SDK、同一事件流**：percho 的 `SessionEvent = PiAgentSessionEvent | …`，即 `@earendil-works/pi-coding-agent` 的 `AgentSessionEvent`——**pi-web 的 SSE `/api/agent/[id]/events` 转发的就是这一族事件**。reducer 可直接喂数据，无需理解 percho 的 Electron IPC。
2. **技术栈几乎重合**：双方都是 React 19 + Tailwind 4（`@theme` CSS 变量体系）+ Next/Electron 前端范式；percho 无 Webpack/Vite 特定代码，组件全是标准 React。
3. **历史转换已有现成纯函数**：percho backend 的 `toSessionMessages()/assignEntryIds()`（messages.ts，341 行）与 pi-web 的 `session-reader.ts` 用的是**同一个 SDK 入口** `SessionManager.open().getEntries()`，可近乎 1:1 搬成 lib。
4. **代码量可控**：shared/transcript 全部 ~1560 行 + chat 组件 ~1920 行，均为独立小文件，依赖清晰（见 3.3）。
5. **MIT 协议**：可合法 vendor 进仓库（保留版权声明）。

### 3.2 阻碍点与对策（风险清单）

| # | 风险 | 影响 | 对策 |
| --- | --- | --- | --- |
| R1 | **pi-web SSE 目前裁剪事件**：`toClientEvent` 丢弃 `turn_start/turn_end/tool_execution_update`、抹掉 `message_update.assistantMessageEvent`（text/thinking/toolcall 增量）、`agent_end` 只留 type。而 percho reducer 恰恰依赖这些增量（平滑流式、稳定 id、工具输出累积全靠它） | 高 | 服务端改为**全量转发**（或新端点 `/events-v2` 并行共存灰度）。改动约 10 行；旧窗口在同一发布里被替换，无长期双轨成本 |
| R2 | percho 组件读 **Zustand store**（transcript/sessions/ui-preferences），pi-web 无 zustand | 中 | 引入 zustand（~1KB，无侵入），新建 `stores/transcript` 由 `useAgentSession` 喂；比拆光 store 改 props 的改动量小一个量级，且保留 percho 原文件结构便于日后对上游 diff |
| R3 | **pi-web 特有消息类型** percho 模型没有：`custom`（扩展/团队/office 推送）、`bashExecution`、extension widgets | 中 | adapter 里映射：`custom → system` 消息或注册为 ToolCallCard 槽位覆盖；`bashExecution → user` 消息变体（一行样式）；ExtensionWidgets/StatusBar 留在 ChatWindow 外围不动 |
| R4 | **optimistic 用户气泡 + 去重**是 pi-web 特有逻辑（percho 无） | 中 | 在 zustand store 层实现 `appendOptimisticUser`，`message_end` 送达时按 pi-web 现有 `userMessageKey` 算法对账——逻辑照搬，位置搬家 |
| R5 | pi-web 独有功能挂在消息流上：**ChangedFilesCard、jumpTarget（内容搜索跳转）、ChatMinimap、lazy-load 窗口化、分支导航、AI 编辑上下文** | 中 | ① ChangedFilesCard：挂在 TurnDiffChip 同位置（buildChatRows 已算出每轮文件集合，注入即可）；② jumpTarget：UIMessage 保留 entryId，按 id 滚动定位；③ minimap/lazy-load：**二期**（percho 靠 reducer 已把 rawToolOutputs 裁出渲染层，长会话压力远小于 pi-web 现状，先全量渲染上线观察） |
| R6 | **新依赖体积**：markstream-react + stream-monaco + monaco-editor（大）+ thinking-orbs | 中 | Markdown/代码块组件 `next/dynamic` 懒加载；monaco 按需语言。首屏 JS 只增 ~30-50KB（monaco 块进异步 chunk） |
| R7 | SDK 小版本差（0.84.2 vs 0.84.3）事件形状漂移 | 低 | 移植前 diff 两版 `AgentSessionEvent` 类型；建议顺手把 pi-web 升到 0.84.3 一劳永逸 |
| R8 | percho 的 i18n（自带 zh/en）与 pi-web 的 useI18n 键空间不同 | 低 | 只搬 chat 相关字符串进 pi-web 词典（~40 键），组件里 `useT → useI18n` 机械替换 |
| R9 | 样式 token 差异（percho：surface/ink-1..faint/shadow-pop/chat-scrollbar） | 低 | 在 globals.css `@theme` 增补一组变量映射到现有明暗主题（双方都是 CSS 变量架构，~60 行） |

### 3.3 需要新增的依赖

```json
{
  "zustand": "^5.0.14",
  "markstream-react": "^0.0.55",
  "stream-markdown": "^0.0.16",
  "stream-monaco": "^0.0.49",
  "monaco-editor": "^0.55.1",
  "thinking-orbs": "^0.3.1"
}
```
（@dnd-kit 仅 percho 会话 tab 用，不搬。）

### 3.4 结论

**可行，推荐执行。** 唯一的高风险项（R1）是 10 行级服务端改动且有灰度路径；其余全是中低风险的可控适配。整体是一次「渲染层 + 状态归约器移植」，pi-web 最有价值的资产——会话管理（rpc-manager、fork/branch、SSE 对账 reconcile、压缩、bash 恢复、扩展 UI 请求、open-file 推送）**一行不动**。

---

## 四、具体方案（三阶段，预估 6–8 人日）

### Phase 0：vendor 落地（0.5–1 天）

```
lib/percho/                       ← packages/shared/src（保持相对结构，头注释标注来源 commit）
  transcript/{types,reducer,chat-rows,mapping,meta-summary,turn-files,helpers,parse-patch}.ts
  errors.ts / subagent.ts / todo.ts / skill-invocation.ts / session.ts(仅类型)
components/percho-chat/           ← packages/desktop/src/renderer/src/components/chat/*
  （MessageList/MessageItem/MetaGroup/ToolCallCard/UserMessage/AssistantMessage/Markdown/
    ErrorNote/RetryNote/SystemMessage/TodoPanel/TurnDiffChip/SubagentRunCard/ImagePreview/
    message-actions/use-shown-working/use-sweep-highlight；CenterOrb 按需）
```
- 机械替换：`@percho/shared` → `@/lib/percho`；`useT` → `useI18n`；store 引用指向新 store。
- **剔除** UI 插件层（Slot/registry）：`Slot` 调用点直接渲染 fallback 组件（留 TODO 日后接 pi-web 自己的 PluginHost）。
- globals.css 增补 percho token 块（明/暗两套）+ `.chat-scrollbar`。
- 验收：`tsc --noEmit` 通过，Storybook 式静态挂载（mock transcript）渲染正常。

### Phase 1：数据桥（2–3 天）

1. **服务端全量事件**（R1）：`app/api/agent/[id]/events/route.ts` 的 `toClientEvent` 改为透传全部字段与类型（删 OMITTED 集合；`assistantMessageEvent` 保留）。用 feature flag `PI_WEB_CHAT_V2` 控制：v2 客户端连全量流，旧 UI 仍走裁剪流（同一 session 两个过滤器，互不干扰）。
2. **历史适配** `lib/percho/adapter/history.ts`：
   - 搬 percho backend `messages.ts` 的 `toSessionMessages/assignEntryIds`（依赖 SDK `parseSessionEntries`，pi-web 已在用同款入口）；
   - 新路由或在现有 session 读取路由加 `?format=ui`，返回 `UIMessage[]`（经 shared `messagesToUIMessages`）。
3. **实时适配** `lib/percho/adapter/live.ts` + `stores/transcript.ts`（zustand）：
   - `handleAgentEvent` 内新增分路：v2 事件原样 `reduceEvent(state, event)`；
   - optimistic 用户消息、`message_end` 对账、compaction/bash/reconcile 语义与 pi-web 现有实现对齐（搬逻辑，不改行为）；
   - 流结束后以历史接口结果**整体重建** transcript（天然纠正任何漏事件，等价于现有 loadSession 兜底）。
4. 验收：headless 浏览器跑通 发消息→流式→工具折叠→错误卡→压缩→历史重开 全链路（新旧窗口同屏对照截图）。

### Phase 2：特性回补与切换（2–3 天）

1. `ChatWindow.tsx` 渲染分支切换到 `<PerchoMessageList />`（保留 ChatInput——输入框不在本次替换范围；保留 minimap 挂载点留待二期适配 rows 数据源）。
2. ChangedFilesCard 挂到 turn 行（数据来自 `deriveTurnChanges`）；`custom/bashExecution` 映射渲染；jumpTarget 按 entryId 定位。
3. i18n 补齐 zh-CN/en 键；明暗主题走查（对照 percho 截图逐项核对折叠组/错误卡/代码块/滚动条）。
4. 按 AGENTS.md 约定做 UI 走查：760px 居中列在小窗宽度下的自适应、折叠展开手感、底部跟随阈值。

### Phase 3：验收与收尾（1 天）

- `tsc --noEmit` + `npm run lint` + 全量测试。
- 长会话（>500 消息）压测：滚动帧率、内存、切会话耗时；不达标再上 rows 虚拟化（二期）。
- 移除裁剪版事件分支与 flag（下一个发布周期）。

## 五、备选方案对比（为什么不选）

| 方案 | 结论 |
| --- | --- |
| B. iframe 嵌 percho 桌面应用 | ❌ 两套会话状态互不可见、无法共享 pi-web 的 rpc 会话与右侧面板联动，伪需求 |
| C. 只抄样式不改架构 | ❌ 拿不到核心价值（平滑流式、折叠组时序、错误卡、事件精度），成本却接近方案 A 的 40% |
| D. 反向：把 pi-web 能力搬进 percho | ❌ pi-web 的 Univer/上传/团队/浏览器桥资产量远大于 percho，方向性错误 |

## 六、上游同步策略

- vendor 目录每文件头标注 `// vendored from Jaxton07/percho <commit> <path>`，不混入本地逻辑改动（本地适配全部收敛在 `adapter/` 与组件 props 层）。
- percho 活跃度高（reducer 注释里有明确的决策编号 D1/B7 等，工程化程度好），建议每季度 diff 一次 `packages/shared/src/transcript/` 增量。
