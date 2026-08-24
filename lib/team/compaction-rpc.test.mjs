/**
 * rpc-manager compaction 命令冒烟测试（不启动真实 pi 会话/LLM）。
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/compaction-rpc.test.mjs
 *
 * 验证 AgentSessionWrapper.send 的三个压缩相关命令：
 *  - get_compaction_settings：返回全局设置
 *  - set_compaction：写全局 + 同步会话内存 enabled
 *  - set_auto_compaction：开关
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { AgentSessionWrapper } = await import("../rpc-manager.ts");
const { __setSettingsPathForTest, writeCompactionSettings, readCompactionSettings } = await import("../compaction-settings.ts");
const fakeSettingsPath = join(mkdtempSync(join(tmpdir(), "pi-compaction-rpc-test-")), "settings.json");
__setSettingsPathForTest(fakeSettingsPath);

// 最小 inner mock（只实现 send 分支用到的成员）
function makeMockInner() {
  const state = { autoCompactionEnabled: true, compacted: 0 };
  return {
    ...state,
    get state() { return state; },
    sessionId: "mock-session-1",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    get autoCompactionEnabled() { return state.autoCompactionEnabled; },
    autoRetryEnabled: true,
    model: undefined,
    pendingMessageCount: 0,
    agent: { state: { systemPrompt: "", thinkingLevel: "off" } },
    sessionManager: {
      getCwd: () => "/mock",
      getSessionName: () => "mock",
      getBranch: () => [],
      isPersisted: () => true,
      getSessionFile: () => undefined,
      getSessionDir: () => "/mock",
      getEntry: () => null,
    },
    settingsManager: {
      getCompactionSettings: () => ({ enabled: state.autoCompactionEnabled, reserveTokens: 16384, keepRecentTokens: 20000 }),
      getEnabledModels: () => [],
      getDefaultProvider: () => undefined,
      getDefaultModel: () => undefined,
      globalSettings: {},
    },
    modelRuntime: { getModel: () => undefined, refresh: async () => {} },
    extensionRunner: { getRegisteredCommands: () => [], hasHandlers: () => false },
    promptTemplates: [],
    resourceLoader: {},
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getLastAssistantText: () => "",
    getSessionStats: () => ({}),
    setAutoCompactionEnabled: (v) => { state.autoCompactionEnabled = v; },
    setAutoRetryEnabled: () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    compact: async () => { state.compacted++; },
    setSessionName: () => {},
    navigateTree: async () => ({ cancelled: true }),
    setActiveToolsByName: () => {},
    getAllTools: () => [],
    getActiveToolNames: () => [],
    subscribe: () => () => {},
    dispose: () => {},
    reload: async () => {},
    bindExtensions: async () => {},
    prompt: async () => {},
    abort: async () => {},
    executeBash: async () => ({ output: "" }),
    abortBash: () => {},
    clearQueue: async () => {},
    isAlive: () => true,
  };
}

test("get_compaction_settings 返回全局设置", async () => {
  writeCompactionSettings({ enabled: true, reserveTokens: 22000, keepRecentTokens: 18000 });
  const wrapper = new AgentSessionWrapper(makeMockInner());
  const result = await wrapper.send({ type: "get_compaction_settings" });
  assert.deepEqual(result, { enabled: true, reserveTokens: 22000, keepRecentTokens: 18000 });
  await wrapper.shutdown();
});

test("set_compaction 写全局并同步会话 enabled", async () => {
  const inner = makeMockInner();
  const wrapper = new AgentSessionWrapper(inner);
  const result = await wrapper.send({ type: "set_compaction", enabled: true, reserveTokens: 30000, keepRecentTokens: 25000 });
  assert.deepEqual(result, { enabled: true, reserveTokens: 30000, keepRecentTokens: 25000 });

  // 全局已写
  assert.deepEqual(readCompactionSettings(), { enabled: true, reserveTokens: 30000, keepRecentTokens: 25000 });
  // 文件已落盘
  const raw = JSON.parse(readFileSync(fakeSettingsPath, "utf-8"));
  assert.equal(raw.compaction.reserveTokens, 30000);
  // 会话内存 enabled 已同步
  assert.equal(inner.autoCompactionEnabled, true);
  // 会话内存 compaction 段已更新（压缩逻辑实时读取）
  assert.deepEqual(inner.settingsManager.globalSettings.compaction, { enabled: true, reserveTokens: 30000, keepRecentTokens: 25000 });
  await wrapper.shutdown();
});

test("set_auto_compaction 开关", async () => {
  const inner = makeMockInner();
  const wrapper = new AgentSessionWrapper(inner);
  await wrapper.send({ type: "set_auto_compaction", enabled: false });
  assert.equal(inner.autoCompactionEnabled, false);
  await wrapper.shutdown();
});
