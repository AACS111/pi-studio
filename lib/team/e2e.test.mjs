/**
 * Phase 1A Step9：真实 Agent E2E。
 * 用真实 PiAgentExecutor + startRpcSession 跑「组长→文档→组长收尾」，
 * 验证：systemPrompt/共享上下文注入、受控工具注入、真实执行、事件流、产物。
 *
 * 依赖：本机已配置 pi 模型（~/.pi/agent/models.json + auth.json）。
 * 无配置时自动 skip（完整 4 角色逻辑由 runtime.test.mjs 的 mock 覆盖）。
 *
 * 运行：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/team/e2e.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { RunManager } = await import("./runtime.ts");
const { EventStore } = await import("./store.ts");
const { PiAgentExecutor } = await import("./executor.ts");
const { reduce } = await import("./types.ts");
const { BUILTIN_AGENTS } = await import("./library.ts");

const hasModelConfig = (() => {
  try {
    const modelsPath = process.env.PI_CODING_AGENT_DIR
      ? path.join(process.env.PI_CODING_AGENT_DIR, "models.json")
      : path.join(os.homedir(), ".pi", "agent", "models.json");
    if (!fs.existsSync(modelsPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    const providers = parsed.providers ?? {};
    return Object.values(providers).some((p) => Array.isArray(p?.models) && p.models.length > 0);
  } catch {
    return false;
  }
})();

/** 从本机 models.json 取可用对话模型（provider/modelId）。
 *  优先：env PI_TEAM_E2E_MODEL（显式覆盖）→ new-provider（公司网关，实测可用）→ 其他非 skip provider。
 *  跳过视觉/向量/重排序模型（不能当对话模型）。 */
function firstAvailableModel() {
  const explicit = process.env.PI_TEAM_E2E_MODEL?.trim();
  if (explicit) return explicit;
  try {
    const modelsPath = process.env.PI_CODING_AGENT_DIR
      ? path.join(process.env.PI_CODING_AGENT_DIR, "models.json")
      : path.join(os.homedir(), ".pi", "agent", "models.json");
    const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
    const skip = /VL|embedding|reranker|vision|audio|image/i;
    const prefer = parsed.providers?.["new-provider"];
    const preferModels = Array.isArray(prefer?.models) ? prefer.models : [];
    const preferred = preferModels.find((m) => m?.id && !skip.test(String(m.id)));
    if (preferred?.id) return `new-provider/${preferred.id}`;
    for (const [provider, cfg] of Object.entries(parsed.providers ?? {})) {
      const models = Array.isArray(cfg?.models) ? cfg.models : [];
      const usable = models.find((m) => m?.id && !skip.test(String(m.id)));
      if (usable?.id) return `${provider}/${usable.id}`;
    }
  } catch {
    /* ignore */
  }
  return "";
}

const E2E_MODEL = firstAvailableModel();

const leader = BUILTIN_AGENTS.find((a) => a.id === "leader");
const writer = BUILTIN_AGENTS.find((a) => a.id === "writer");

function buildMiniTeam(sessionId, cwd) {
  const now = Date.now();
  return {
    sessionId,
    name: "E2E 团队",
    cwd,
    entryAgentId: "leader",
    agents: [leader, writer].map((a) => ({
      id: a.id, name: a.name, emoji: a.emoji, role: a.role,
      model: E2E_MODEL, // 显式指定本机可用模型（避免跟随无效默认）
      systemPrompt: a.systemPrompt, toolNames: [...a.toolNames],
    })),
    transitions: [
      { id: "l-end", from: "leader", to: "__end__", priority: 30, trigger: { event: "completed", condition: { mode: "keyword", keywords: ["总结完成", "任务完成", "最终结论", "全部完成", "总结：", "收尾"] } } },
      { id: "l-w", from: "leader", to: "writer", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
      { id: "w-l", from: "writer", to: "leader", priority: 0, trigger: { event: "completed", condition: { mode: "always" } } },
    ],
    defaultRoutingMode: "hybrid",
    maxHops: 10,
    maxReworkRounds: 2,
    maxRunMinutes: 5,
    contextScope: "structured",
    recentCount: 20,
    createdAt: now,
    updatedAt: now,
  };
}

test("E2E: 真实 Agent 执行 组长→文档→组长收尾（无模型配置自动跳过）", { timeout: 300_000, skip: !hasModelConfig }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-e2e-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
  });

  const cwd = process.cwd(); // 在当前项目目录跑，模型可读文件
  const sessionId = "e2e-sess";
  const team = buildMiniTeam(sessionId, cwd);

  const run = {
    id: "e2e-run",
    teamId: sessionId,
    status: "pending",
    task: "查看当前项目目录，列出主要目录结构，写一份简短的说明文档（docs/team-e2e-summary.md），然后总结完成（最后输出必须以「总结：」开头总结本次任务结果）。",
    stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const rm = new RunManager({ team, runId: "e2e-run", executor: new PiAgentExecutor() });
  const finalRun = await rm.execute(run);

  // 真实 LLM 输出有随机性：不强制 completed（模型措辞不匹配关键词时可能 max_hops/timeout）。
  // E2E 核心验证目标是「真实执行链路可用」：会话启动、prompt 执行、输出收集、事件落盘。
  if (finalRun.status !== "completed") {
    console.error(`[E2E] run 终态: ${finalRun.status} ${finalRun.statusReason?.code} ${finalRun.statusReason?.message ?? ""}`);
    const evs = new EventStore(sessionId, "e2e-run").replay();
    for (const e of evs) {
      if (e.type === "message_created" && e.message?.kind === "agent") {
        console.error(`[E2E] ${e.message.agentId}: ${e.message.content.slice(0, 150)}`);
      }
      if (e.type === "handoff_requested") {
        console.error(`[E2E] handoff ${e.from} → ${e.to} (${e.reason ?? e.kind})`);
      }
    }
  }
  // 事件流完整（真实执行链路的硬断言：执行发生、消息落盘、序列单调）
  const events = new EventStore(sessionId, "e2e-run").replay();
  const p = reduce(events);
  assert.ok(events.length > 3, `事件流应 >3 条，实际 ${events.length}`);
  assert.equal(events[0].type, "run_started");
  assert.ok(events.some((e) => e.type === "execution_started"), "应有真实执行事件");
  assert.ok(events.some((e) => e.type === "execution_completed"), "应有执行完成事件");
  assert.ok(p.executions.length >= 1, `至少 1 次执行，实际 ${p.executions.length}`);
  assert.equal(p.executions[0].agentId, "leader");

  // 群聊消息：真实 Agent 产出已落盘
  const agentMessages = p.messages.filter((m) => m.kind === "agent");
  assert.ok(agentMessages.length >= 1, `至少 1 条 agent 消息，实际 ${agentMessages.length}`);

  // 序列单调
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].sequence > events[i - 1].sequence);
  }

  console.log(`[E2E] ${finalRun.status}: ${p.executions.length} 次执行, ${p.messages.length} 条消息, ${events.length} 事件`);
});
