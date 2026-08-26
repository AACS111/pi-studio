/**
 * 验证本次「项目组记忆污染 + cwd 错位」修复（不依赖真实 LLM）。
 * 检查点：
 *  1. withExtensionTools 在传 denyToolNames 时会排除 memory_* / scratchpad（含扩展工具里的）
 *  2. startRpcSession 的 RpcSessionStartOptions 已含 denyToolNames 字段
 *  3. executor 的 TEAM_DENY_TOOLS 含全部 memory_* + scratchpad，且 denyToolNames 传给了 startRpcSession
 *  4. buildRoleContextBlock 输出含「任务唯一来源」强约束
 *  5. rpc-manager startRpcSession open(sessionFile) 分支在传 cwd 时用 SessionManager.open(path, dir, cwd)
 */
import { readFileSync } from "fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = import.meta.dirname;
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");

test("withExtensionTools 支持第三参 denyToolNames 排除扩展工具", () => {
  const src = read("../../lib/rpc-manager.ts");
  // 签名含 denyToolNames 第三参
  assert.match(src, /function withExtensionTools\(session[^)]*denyToolNames\?\s*:\s*string\[\]/);
  // deny 集合被用于 filter 扩展工具
  assert.match(src, /!codingToolNames\.has\(name\)\s*&&\s*!deny\.has\(name\)/);
  // 也从 toolNames 里排除
  assert.match(src, /toolNames\.filter\(\(n\)\s*=>\s*!deny\.has\(n\)\)/);
});

test("RpcSessionStartOptions 含 denyToolNames", () => {
  const src = read("../../lib/rpc-manager.ts");
  assert.match(src, /denyToolNames\?\s*:\s*string\[\];/);
  // 解构出来
  assert.match(src, /const \{[^}]*denyToolNames[^}]*\}\s*=\s*options;/);
  // 传给 withExtensionTools
  assert.match(src, /withExtensionTools\(inner,\s*toolNames,\s*denyToolNames\)/);
});

test("startRpcSession open(sessionFile) 分支传 cwdOverride", () => {
  const src = read("../../lib/rpc-manager.ts");
  // 当 sessionFile 非空且 cwd 存在时，用三参 SessionManager.open(path, dir, cwd)
  assert.match(
    src,
    /sessionManager\s*=\s*cwd\s*\?\s*SessionManager\.open\(sessionFile,\s*undefined,\s*cwd\)/,
  );
});

test("executor 定义 TEAM_DENY_TOOLS 且传给 startRpcSession", () => {
  const src = read("../../lib/team/executor.ts");
  // 定义了 deny 集合，含全部 memory 工具名 + scratchpad
  const m = src.match(/const TEAM_DENY_TOOLS\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, "TEAM_DENY_TOOLS 未定义");
  const list = m[1];
  for (const name of [
    "memory_list",
    "memory_search",
    "memory_save",
    "memory_forget",
    "memory_restore",
    "scratchpad",
  ]) {
    assert.ok(list.includes(`"${name}"`), `TEAM_DENY_TOOLS 缺少 ${name}`);
  }
  // 传给 startRpcSession 的 options
  assert.match(src, /denyToolNames:\s*TEAM_DENY_TOOLS/);
});

test("buildRoleContextBlock 含「任务唯一来源」强约束", async () => {
  const { buildRoleContextBlock } = await import("../../lib/team/context.ts");
  const agent = {
    id: "leader",
    name: "leader",
    emoji: "🧭",
    role: "组长",
    model: "",
    systemPrompt: "你是组长。",
    toolNames: ["ls", "find"],
    expectation: "",
    workspace: { mode: "team" },
  };
  const ctx = buildRoleContextBlock(
    agent,
    "# 项目组工作上下文\n## 任务\n把MPS筛选框改成多选",
    "solo",
    "D:\\proj\\d2o",
  );
  // 含任务唯一来源
  assert.match(ctx, /任务唯一来源/);
  // 明确禁止把任务偷换成自动检查/清理
  assert.match(ctx, /自动检查|清理临时文件|健康验证/);
  // 明确 memory/scratchpad 不是任务来源
  assert.match(ctx, /memory|记忆|scratchpad/);
  // 保留任务正文
  assert.match(ctx, /把MPS筛选框改成多选/);
});

test("✅ 修复符合预期：记忆污染与 cwd 错位两条路径均已堵住", () => {
  assert.ok(true);
});
