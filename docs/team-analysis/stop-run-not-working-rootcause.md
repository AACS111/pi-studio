# 停止对话无法停止项目组 — 根因定位报告（组长/研究员）

## 复现现象
用户点击「停止对话」按钮后，项目组执行中当前这波角色（研究员/开发/文档）仍一直显示「正在执行」，无法停止。

## 完整链路（已核实源码）
前端停止按钮（`components/TeamChat.tsx:607` `onClick={() => void data.cancelRun()}`）
→ `hooks/useTeamRun.ts:184` `cancelRun()` 
→ `POST /api/teams/runs/[runId]/cancel`
→ `app/api/teams/runs/[runId]/cancel/route.ts` → `lib/team/registry.ts:87` `cancelTeamRun(runId)`
→ `manager.cancel()`（`lib/team/runtime.ts:444`）→ **仅置位 `this.cancelled = true`，别无其他。**

## 根因（两处泄漏）

### 泄漏 1：executor 完全不感知取消
`lib/team/executor.ts` `PiAgentExecutor.run()`：
```ts
await withTimeout(
  session.inner.prompt(...),
  timeoutMs,
  async () => { await session.send({ type: "abort" }); },  // 只有超时会 abort
);
```
它没有任何「取消信号（cancel）」输入。用户停止对话→`this.cancelled=true` 这个状态**永远不会传导到正在跑的 pi 会话**。`session.inner.prompt()` 会一直阻塞直到该角色回合自然结束（写完输出→提交 team_handoff）。

### 泄漏 2：runtime 只在波次泵循环顶部检查取消
`lib/team/runtime.ts` `cancel()`：
```ts
cancel(): void {
  this.cancelled = true;
  this.approvalResolver?.(false);
}
```
取消标记只在 `pump()` 的**每次波次循环顶部**检查：
```ts
if (this.cancelled) { this.terminal = {...user_cancelled...}; break; }
```
而 pump 此刻正阻塞在
```ts
this.inflight += agentNodes.length;
await Promise.all(agentNodes.map(a => this.launchAgent(a)));  // ← 这波全跑完才返回
```
也就是说：当前这波并发执行的角色必须**全部自然跑完回合**，pump 才能回到顶部看到 cancelled。所以「研究员/开发/文档」会一直执行到各自回合结束——用户点一次停止也停不下来（除非每个角色都是短回合）。

## 修复方向
让 cancel 立即生效：
1. `executor.ts`：`AgentExecutionRequest` / `executor.run()` 增加可取消机制（如 `AbortSignal`，或 `session.send({type:"abort"})` 由外部触发），使用户取消能提前 abort 正在跑的 pi 会话并让 `prompt()` 提前返回。
2. `runtime.ts`：`cancel()` 时把取消信号下发给**当前 inflight 的全部 executor**（记录每个 inflight execution 对应的 cancel 回调或 signal），使 `Promise.all(...launchAgent)` 提前解开；pump 随即回到顶部看到 `cancelled` 而 `finish(user_cancelled)`。

## 修复内容（已实现 + 验证）

1. `lib/team/executor.ts`：
   - `AgentExecutionRequest` 新增 `signal?: AbortSignal`。
   - `PiAgentExecutor.run()` 监听 `signal`：收到 abort → `session.send({type:"abort"})`，并用 `Promise.race` 让 `session.inner.prompt()` 提前 reject（不再等回合自然结束）。无 signal 时行为不变（向后兼容 mock 执行器/测试）。
2. `lib/team/runtime.ts`：
   - 新增 `private readonly controller = new AbortController()`（共享信号）。
   - `cancel()` 改为 `this.cancelled = true; this.abortInflight(); this.approvalResolver?.(false)`——abort 一次即同时下发给当前 inflight 的**所有**并行执行（研究员/开发/文档共享同一信号）。
   - 终态定级把 `user_cancelled` 提到最高优先级（覆盖中途可能出现的 dead_end/超时/返工 terminal）。
3. 新增回归测试（`lib/team/runtime.test.mjs`，串行+并行两个用例）：
   - 串行：运行中 `rm.cancel()` → 正在执行的 agent 拿到已 abort 的信号，run 快速进入 `user_cancelled`，不再接力。
   - 并行（solver 模板）：三分支 inflight 时 `cancel()` → 全部分支收到 abort 信号，run 终态 `user_cancelled`，无新增执行。

## 验证结果
- `tsc --noEmit` ✅
- `npx eslint lib/team/executor.ts lib/team/runtime.ts` ✅（无告警）
- `node --import ./lib/team/node-loader.mjs --test lib/team/runtime.test.mjs` → 7/7 通过（含新增取消用例）
- `lib/team/{runtime,parallel,gateway,lifecycle,engine,tools}.test.mjs` → 38/38 通过
- `benchmark.test.mjs` → 6/6（偶发失败为墙钟计时波动，非逻辑回归）
- 其余既有失败（compaction-rpc / e2e）为 node-loader「parameter property 不支持 strip-only」的环境问题，与本次改动无关。