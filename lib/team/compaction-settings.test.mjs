/**
 * compaction-settings 单元测试（node:test）
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/compaction-settings.test.mjs
 *
 * 验证：
 *  - 默认值（无 compaction 段 → pi 内置默认）
 *  - 写入/读取往返（原子写、保留其他段）
 *  - 推荐阈值（触发点 ≈ 窗口 85%）
 *  - 边界：非法 token 值 clamp、显式配置检测
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const {
  COMPACTION_DEFAULTS,
  recommendedCompactionForWindow,
  readCompactionSettings,
  writeCompactionSettings,
  hasExplicitCompaction,
  __setSettingsPathForTest,
} = await import("../compaction-settings.ts");

const fakeSettingsPath = join(mkdtempSync(join(tmpdir(), "pi-compaction-test-")), "settings.json");
__setSettingsPathForTest(fakeSettingsPath);

test("默认值与 pi 内置一致", () => {
  assert.equal(COMPACTION_DEFAULTS.enabled, true);
  assert.equal(COMPACTION_DEFAULTS.reserveTokens, 16384);
  assert.equal(COMPACTION_DEFAULTS.keepRecentTokens, 20000);
});

test("无文件 / 无 compaction 段 → 返回内置默认", () => {
  // 文件不存在
  assert.equal(existsSync(fakeSettingsPath), false);
  const d = readCompactionSettings();
  assert.equal(d.enabled, true);
  assert.equal(d.reserveTokens, 16384);
  assert.equal(d.keepRecentTokens, 20000);
  // 有文件但无 compaction 段
  writeFileSync(fakeSettingsPath, JSON.stringify({ defaultProvider: "x" }), "utf-8");
  const d2 = readCompactionSettings();
  assert.equal(d2.enabled, true);
  assert.equal(d2.reserveTokens, 16384);
});

test("写入→读取往返，且保留文件其他段", () => {
  writeFileSync(fakeSettingsPath, JSON.stringify({ defaultProvider: "new-provider", defaultModel: "glm-5.2" }), "utf-8");
  const merged = writeCompactionSettings({ enabled: true, reserveTokens: 20000, keepRecentTokens: 15000 });
  assert.equal(merged.enabled, true);
  assert.equal(merged.reserveTokens, 20000);
  assert.equal(merged.keepRecentTokens, 15000);

  const read = readCompactionSettings();
  assert.deepEqual(read, merged);

  // 其他段保留
  const raw = JSON.parse(readFileSync(fakeSettingsPath, "utf-8"));
  assert.equal(raw.defaultProvider, "new-provider");
  assert.equal(raw.defaultModel, "glm-5.2");
});

test("部分更新只改指定字段", () => {
  writeCompactionSettings({ enabled: false });
  const read = readCompactionSettings();
  assert.equal(read.enabled, false);
  assert.equal(read.reserveTokens, 20000); // 保留上次
  assert.equal(read.keepRecentTokens, 15000);
});

test("非法 token 值 clamp 到安全范围", () => {
  writeCompactionSettings({ reserveTokens: 0, keepRecentTokens: -5 });
  const read = readCompactionSettings();
  assert.ok(read.reserveTokens >= 1024);
  assert.ok(read.keepRecentTokens >= 1024);

  writeCompactionSettings({ reserveTokens: 999999999 });
  assert.ok(readCompactionSettings().reserveTokens <= 1_000_000);
});

test("hasExplicitCompaction：无段 false，有段 true", () => {
  writeFileSync(fakeSettingsPath, JSON.stringify({}), "utf-8");
  assert.equal(hasExplicitCompaction(), false);

  writeCompactionSettings({ enabled: true });
  assert.equal(hasExplicitCompaction(), true);

  writeFileSync(fakeSettingsPath, JSON.stringify({ defaultModel: "x" }), "utf-8");
  assert.equal(hasExplicitCompaction(), false);
});

test("推荐阈值：131072 窗口触发点约 85%", () => {
  const rec = recommendedCompactionForWindow(131072);
  assert.equal(rec.enabled, true);
  assert.equal(rec.reserveTokens, Math.round(131072 * 0.15));
  assert.equal(rec.keepRecentTokens, Math.round(131072 * 0.15));
  const triggerAt = 131072 - rec.reserveTokens;
  const pct = triggerAt / 131072;
  assert.ok(pct > 0.83 && pct < 0.87, `触发点 ${(pct * 100).toFixed(1)}% 应在 83~87%`);
});

test("推荐阈值：262144 窗口", () => {
  const rec = recommendedCompactionForWindow(262144);
  assert.equal(rec.reserveTokens, Math.round(262144 * 0.15));
  assert.equal(rec.keepRecentTokens, Math.round(262144 * 0.15));
});

test("推荐阈值：非法窗口回退 128000；极大窗口按比例（clamp 在写入层）", () => {
  const rec = recommendedCompactionForWindow(0);
  assert.equal(rec.reserveTokens, Math.round(128000 * 0.15));
  const recNeg = recommendedCompactionForWindow(-5);
  assert.equal(recNeg.reserveTokens, Math.round(128000 * 0.15));
  const recBig = recommendedCompactionForWindow(9999999);
  assert.equal(recBig.reserveTokens, Math.round(9999999 * 0.15)); // 按比例，未 clamp
  // 写入层 clamp 到 1M
  writeCompactionSettings({ reserveTokens: recBig.reserveTokens, keepRecentTokens: recBig.keepRecentTokens });
  const persisted = readCompactionSettings();
  assert.ok(persisted.reserveTokens <= 1_000_000);
  assert.ok(persisted.keepRecentTokens <= 1_000_000);
});
