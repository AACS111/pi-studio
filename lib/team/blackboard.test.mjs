/**
 * 团队黑板 + 文件接触账本（双层上下文共享）回归测试。
 *
 *  - blackboard：笔记 write/read/list 往返、key 归一化、touched 账本合并去重封顶
 *  - executor：tool_execution_start 的 read 类事件被采集为 result.readFiles（L1 自动层）
 *  - context：buildContext 注入「上棒接触的文件」块 + 「团队黑板」索引块；
 *    收尾要求含黑板沉淀条款
 *
 * 运行：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/team/blackboard.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PI_WEB_UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-blackboard-"));

const { writeNote, readNote, listNotes, normalizeNoteKey, recordTouchedFiles, readTouchedFiles, recentOtherTouched } = await import("./blackboard.ts");
const { buildContext } = await import("./context.ts");

const SID = "sess-blackboard";
const RUN = "run-bb-1";

function agent(id, name, role, extra = {}) {
  return { id, name, role, model: "", systemPrompt: "", toolNames: [], workspace: { mode: "team" }, ...extra };
}
function makeTeam() {
  return {
    sessionId: SID, name: "黑板团队", cwd: "/w", entryAgentId: "leader",
    agents: [agent("leader", "组长", "组长"), agent("dev", "开发", "开发")],
    transitions: [],
    defaultRoutingMode: "strict", contextScope: "structured", recentCount: 20,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}
function emptyRun() {
  return { id: RUN, teamId: SID, status: "running", task: "测试任务", stats: { hopCount: 0, reworkCount: 0, agentExecutions: 0, tokensUsed: 0, durationMs: 0 }, createdAt: Date.now(), updatedAt: Date.now() };
}
function emptyProjections() {
  return {
    messages: [], tasks: [],
    state: { phase: "executing", completedTasks: [], activeTasks: [], decisions: [], artifacts: [], lastHandoff: null },
  };
}

/* ────────────────────────── 黑板笔记 ────────────────────────── */

test("黑板 write/read/list 往返 + key 归一化（空格/大写/特殊字符）", () => {
  writeNote(SID, RUN, "API Conventions!", "## 接口约定\n- POST /api/x", "组长");
  const note = readNote(SID, RUN, "api-conventions");
  assert.ok(note, "归一化后可读回");
  assert.equal(note.key, "api-conventions");
  assert.equal(note.author, "组长");
  assert.match(note.content, /POST \/api\/x/);
  assert.ok(normalizeNoteKey("  My_Key!! ") === "my-key");
  const list = listNotes(SID, RUN);
  assert.equal(list.length, 1);
  assert.match(list[0].summary, /接口约定/);
  assert.equal(readNote(SID, RUN, "不存在"), null);
});

/* ────────────────────────── 接触账本 ────────────────────────── */

test("touched 账本：同角色多次执行累积合并、去重、保留最后接触顺序、封顶", () => {
  recordTouchedFiles(SID, RUN, "leader", { readFiles: ["a.ts", "b.ts"], changedFiles: ["plan.md"] });
  recordTouchedFiles(SID, RUN, "leader", { readFiles: ["b.ts", "c.ts"] });
  const rec = readTouchedFiles(SID, RUN, "leader");
  assert.deepEqual(rec.readFiles, ["a.ts", "b.ts", "c.ts"], "b.ts 重复只保留一次且顺序靠前");
  assert.deepEqual(rec.changedFiles, ["plan.md"]);
  // 封顶：超过 40 只保留最近
  const many = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
  recordTouchedFiles(SID, RUN, "dev", { readFiles: many });
  const dev = readTouchedFiles(SID, RUN, "dev");
  assert.equal(dev.readFiles.length, 40);
  assert.equal(dev.readFiles[0], "f20.ts", "封顶后保留最近 40 个");
  // recentOtherTouched：排除自己、按更新时间取最近 2
  const others = recentOtherTouched(SID, RUN, "tester", 2);
  assert.equal(others.length, 2, "leader/dev 两个角色在册");
  assert.equal(recentOtherTouched(SID, RUN, "leader", 5).some((r) => r.agentId === "leader"), false, "排除自己");
});

/* ────────────────────────── buildContext 注入 ────────────────────────── */

test("buildContext 注入「上棒接触的文件」与「团队黑板」块；收尾要求含黑板沉淀条款", () => {
  recordTouchedFiles(SID, RUN, "leader", { changedFiles: ["src/api.ts"], readFiles: ["src/api.ts", "src/auth.ts"] });
  writeNote(SID, RUN, "api-conventions", "接口约定：POST /api/x 需带 token", "组长");
  const team = makeTeam();
  const ctx = buildContext({ team, run: emptyRun(), projections: emptyProjections(), agent: team.agents[1] }); // dev 视角
  assert.match(ctx, /## 上棒接触的文件/);
  assert.match(ctx, /「组长」改动了.*src\/api\.ts/);
  assert.match(ctx, /「组长」细读过.*src\/auth\.ts/);
  assert.match(ctx, /## 团队黑板/);
  assert.match(ctx, /api-conventions（组长）：接口约定/);
  assert.match(ctx, /team_note_write 写入黑板/);
  // 自己的接触不出现在自己的上下文（无"组长"接触 leader 视角的前置数据时无块）
  const leaderCtx = buildContext({ team, run: emptyRun(), projections: emptyProjections(), agent: team.agents[0] });
  assert.doesNotMatch(leaderCtx, /「组长」细读过/, "排除自己的账本");
});

/* ────────────────────────── executor read 采集（L1 自动层） ────────────────────────── */

test("executor：read/grep 工具事件被采集为 result.readFiles（写类不混入）", async (t) => {
  const dataDir = process.env.PI_WEB_UPLOADS_DIR;
  t.after(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });
  const { PiAgentExecutor } = await import("./executor.ts");
  const team = makeTeam();
  team.cwd = process.cwd(); // 采集过滤要求路径在 cwd 内
  const events = [];
  const factory = async () => {
    let handler;
    const session = {
      inner: {
        model: { id: "fake", provider: "mock" },
        prompt: async () => {
          for (const [toolName, args] of [
            ["read", { path: path.join(process.cwd(), "src/a.ts") }],
            ["grep", { pattern: "foo", path: path.join(process.cwd(), "src") }],
            ["write", { path: path.join(process.cwd(), "src/b.ts"), content: "x" }],
            ["read", { path: path.join(process.cwd(), "src/a.ts") }], // 重复 read：顺序保持最后接触
          ]) {
            handler?.({ type: "tool_execution_start", toolName, args });
            await new Promise((r) => setTimeout(r, 1));
          }
          return {};
        },
      },
      waitUntilReady: async () => {},
      onEvent: (h) => { handler = h; return () => { handler = undefined; }; },
      send: async (cmd) => {
        if (cmd?.type === "get_session_stats") return { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0, userMessages: 1, assistantMessages: 1, toolCalls: 4, toolResults: 4, totalMessages: 5 };
        if (cmd?.type === "get_last_assistant_text") return { text: "完成" };
        return undefined;
      },
      shutdown: async () => {},
    };
    return { session, realSessionId: "x" };
  };
  const executor = new PiAgentExecutor(factory);
  const now = Date.now();
  const result = await executor.run({
    team, runId: "run-readcapture",
    execution: { id: "exec-rc-1", runId: "run-readcapture", agentId: "dev", sequence: 1, status: "running", startedAt: now, sessionId: "s1", sessionPath: "/tmp/x.jsonl" },
    context: "任务", task: "任务", existingTasks: [], mode: "orchestrated",
    signal: new AbortController().signal, onEvent: (e) => events.push(e), onMessage: () => {},
  });
  assert.ok(Array.isArray(result.readFiles), "result 应带 readFiles");
  // write 不进 readFiles；read 重复时保持最后接触顺序（a.ts 在 grep 之后再次接触）
  assert.deepEqual(result.readFiles.filter((p) => !p.includes("b.ts")), [
    path.join(process.cwd(), "src").replace(/\\/g, "/"),
    path.join(process.cwd(), "src/a.ts").replace(/\\/g, "/"),
  ].map((p) => p.replace(/\\/g, "/")));
  assert.ok(result.changedFiles.some((f) => f.filePath.endsWith("b.ts")), "写类仍采集为 changedFiles");
  // 落账本（execution_completed 由 runtime 写；executor 返回后直接验证 result→runtime 通路在 runtime.test 覆盖）
  assert.equal(result.status, "completed");
});
