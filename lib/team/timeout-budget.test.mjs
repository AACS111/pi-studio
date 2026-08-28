/** 执行时间预算纯函数回归（run 907d9c13 复盘：8 角色团队人均只分到 6.4min，深度思考模型被腰斩）。
 *  运行：node --import ./lib/team/node-loader.mjs --test lib/team/timeout-budget.test.mjs */
import assert from "node:assert/strict";
import test from "node:test";

const { computeExecutionTimeoutMs } = await import("./executor.ts");

test("显式 agent.timeoutMs 永远最优先（角色耗时天然不同）", () => {
  assert.equal(
    computeExecutionTimeoutMs({ maxRunMinutes: 60, agentCount: 8, participantCount: 4, explicitTimeoutMs: 25 * 60_000 }),
    25 * 60_000,
  );
});

test("DAG 计划参与者数参与分摊：闲置角色不再稀释预算", () => {
  // 60min × 0.75 / (3 参与者 - 1) = 22.5min（旧公式除以 8-1 只有 6.4min）
  const ms = computeExecutionTimeoutMs({ maxRunMinutes: 60, agentCount: 8, participantCount: 3 });
  assert.ok(Math.abs(ms - 22.5 * 60_000) < 1000, `实际 ${ms}`);
});

test("无 participantCount 时兜底：团队规模封顶 4，不再按全队人数除", () => {
  const big = computeExecutionTimeoutMs({ maxRunMinutes: 60, agentCount: 10 });
  const small = computeExecutionTimeoutMs({ maxRunMinutes: 60, agentCount: 4 });
  assert.equal(big, small); // 8 人以上都封顶 → 同值
  assert.ok(Math.abs(small - 15 * 60_000) < 1000);
});
