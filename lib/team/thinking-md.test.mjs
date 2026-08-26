/**
 * 验证 PiAgentExecutor 的「思考落盘 .md + 改动文件采集」链路（注入 mock 会话，不走真实 LLM）。
 * 覆盖：①executor 把 thinking 流水写入 runs/<runId>/thinking/<agentId>.md（可读 markdown，而非 .jsonl）
 *      ②tool write 事件 → changedFiles 采集进 ExecutionResult（供前端 changedFiles 卡片）
 *      ③角色最终输出为空时 → 消息兜底生成可见群聊消息
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/thinking-md.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { PiAgentExecutor } = await import("./executor.ts");
const { createTeamDef } = await import("./templates.ts");
const { getTeamDir } = await import("./store.ts");

function useTempDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-md-"));
  process.env.PI_WEB_UPLOADS_DIR = root;
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return root;
}

/** mock 会话：prompt 被调用时向已订阅 handler 发射 thinking_delta + tool write 事件；send 控制返回 */
function makeFakeSessionFactory() {
  return async (sessionId) => {
    let handler;
    const session = {
      inner: {
        model: { id: "fake", provider: "mock" },
        prompt: async () => {
          // 模拟执行期间：先思考，再调用 write 写入一个前置文件
          handler?.({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "我在思考如何把筛选框由单选改为多选（最多2个）\n" } });
          handler?.({ type: "tool_execution_start", toolName: "write", args: { path: "src/main/java/com/foo/FilterBar.vue" } });
          return {};
        },
      },
      waitUntilReady: async () => {},
      onEvent: (h) => { handler = h; return () => { handler = undefined; }; },
      send: async (cmd) => {
        switch (cmd?.type) {
          case "get_session_stats":
            return { tokens: { input: 50, output: 80, cacheRead: 100, cacheWrite: 20, total: 250 }, cost: 0.001, userMessages: 1, assistantMessages: 1, toolCalls: 1, toolResults: 1, totalMessages: 2 };
          case "get_last_assistant_text":
            return { text: "" }; // 空 → 触发「消息兜底」
          case "set_compaction": case "abort": case "steer":
            return undefined;
          default:
            return undefined;
        }
      },
      shutdown: async () => {},
    };
    return { session, realSessionId: sessionId };
  };
}

test("executor: 思考流水落 .md + 改动文件采集 + 空输出消息兜底", async (t) => {
  useTempDataDir(t);
  const team = createTeamDef("sess-思考md", "/w", "验证团队");
  team.cwd = "/w";

  const execution = {
    id: "exec-md-1",
    runId: "run-md-1",
    agentId: "leader",
    sequence: 1,
    status: "running",
    startedAt: Date.now(),
    sessionId: team.sessionId,
  };

  const messages = [];
  const result = await new PiAgentExecutor(makeFakeSessionFactory()).run({
    team,
    runId: "run-md-1",
    execution,
    context: "## 任务\n把 MPS 筛选框单选改多选（最多2个）",
    existingTasks: [],
    task: "把 MPS 页「独立需求单号」筛选项由单选改为多选（最多2个）",
    mode: "orchestrated",
    signal: new AbortController().signal,
    onEvent: () => {},
    onMessage: (m) => messages.push(m),
  });

  assert.equal(result.status, "completed", "执行应完成");

  // ① thinking 落 .md（可读），而非只留 .jsonl
  assert.ok(result.thinkingPath, "result 应携带 thinkingPath（.md 绝对路径）");
  assert.match(result.thinkingPath, /\.md$/, "thinkingPath 应为 .md 文件");
  assert.ok(fs.existsSync(result.thinkingPath), "思考 .md 文件应已落盘");

  const expectedThinkingFile = path.join(getTeamDir(team.sessionId), "runs", "run-md-1", "thinking", "leader.md");
  assert.equal(result.thinkingPath, expectedThinkingFile, "thinkingPath 应指向 runs/<runId>/thinking/<agentId>.md");

  const md = fs.readFileSync(result.thinkingPath, "utf8");
  assert.match(md, /思考如何把筛选框/, "思考 .md 内容应包含思考流水文本");
  assert.match(md, /## 执行 #1/, "思考 .md 应按「执行 #seq」分段");

  // ② 改动文件采集（write）→ ExecutionResult.changedFiles
  assert.ok(result.changedFiles && result.changedFiles.length > 0, "result 应带 changedFiles");
  assert.deepEqual(
    result.changedFiles.find((f) => f.filePath.endsWith("FilterBar.vue")),
    { filePath: "src/main/java/com/foo/FilterBar.vue", kind: "write" },
    "write 工具应采集为 changedFiles（kind=write）",
  );

  // ③ 最终输出为空 → 消息兜底生成可见群聊消息（含改动文件摘要）
  assert.ok(messages.length > 0, "无文本输出时仍应兜底生成群聊消息");
  assert.ok(messages[0].content.includes("FilterBar.vue"), "兜底消息应含改动文件");
  assert.equal(messages[0].executionId, "exec-md-1");
});
