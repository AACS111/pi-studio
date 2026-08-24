/**
 * Phase 1A Step3 验证：生命周期（新建/转换/转回/删除 + 历史导入）。
 * 运行：node --import ./lib/team/node-loader.mjs --test lib/team/lifecycle.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { createTeam, convertTeam, setTeamUiMode, deleteTeam, readTeamChat, extractText } =
  await import("./lifecycle.ts");
const { TeamStore, getTeamDir } = await import("./store.ts");

function useTempEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-team-lc-"));
  process.env.PI_WEB_UPLOADS_DIR = root;          // pi-studio 数据目录（teams）
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent"); // pi 会话目录
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.PI_WEB_UPLOADS_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
  });
  return root;
}

test("createTeam: 新建宿主会话 + team.json + index", (t) => {
  const root = useTempEnv(t);
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd, { recursive: true });

  const { sessionId, sessionFile, team } = createTeam({ cwd, name: "库存分析", templateId: "software-dev" });

  assert.ok(sessionId);
  assert.ok(fs.existsSync(sessionFile), "宿主会话文件存在");
  assert.equal(team.entryAgentId, "leader");
  assert.equal(team.agents.length, 4);
  assert.equal(TeamStore.read(sessionId)?.name, "库存分析");
  assert.equal(TeamStore.list()[sessionId].uiMode, "team");

  // 宿主会话可被 SessionManager 打开
  const sm = SessionManager.open(sessionFile);
  assert.equal(sm.getSessionId(), sessionId);
});

test("convertTeam: 历史导入 user/imported 映射、工具剔除", async (t) => {
  const root = useTempEnv(t);
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd, { recursive: true });

  // 构造一个带历史消息的真实 pi 会话
  const sm = SessionManager.create(cwd, undefined);
  const sessionFile = sm.newSession({});
  assert.ok(sessionFile);
  sm.appendMessage({ role: "user", content: "帮我分析库存差异" });
  sm.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "我先看一下数据文件" },
      { type: "tool_call", id: "tc1", name: "bash", arguments: "ls" },
    ],
  });
  sm.appendMessage({ role: "tool", tool_call_id: "tc1", content: "file list" });
  sm.appendMessage({ role: "assistant", content: "数据分析完成，差异集中在 SKU-103" });
  const sessionId = sm.getSessionId();

  const { importedCount, team } = await convertTeam({ sessionId, name: "转换团队", templateId: "software-dev" });
  assert.equal(importedCount, 3); // user + assistant ×2（tool 消息剔除）
  assert.equal(team.agents.length, 4);

  const chat = readTeamChat(sessionId);
  assert.equal(chat.length, 4); // system 引导 + 3 条导入
  assert.equal(chat[0].kind, "system");
  assert.equal(chat[1].kind, "user");
  assert.equal(chat[1].content, "帮我分析库存差异");
  assert.equal(chat[2].kind, "agent");
  assert.equal(chat[2].agentId, "assistant");
  assert.equal(chat[2].role, "原会话");
  assert.equal(chat[2].content, "我先看一下数据文件"); // tool_call 块剔除，只剩 text
  assert.equal(chat[3].kind, "agent");
  assert.equal(chat[3].content, "数据分析完成，差异集中在 SKU-103");

  // 已是项目组，重复转换报错
  await assert.rejects(() => convertTeam({ sessionId }), /already a team/);
});

test("setTeamUiMode: 转回普通会话（数据保留）/ 恢复项目组", (t) => {
  const root = useTempEnv(t);
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd, { recursive: true });
  const { sessionId } = createTeam({ cwd, name: "t" });

  setTeamUiMode(sessionId, "chat");
  assert.equal(TeamStore.list()[sessionId].uiMode, "chat");
  assert.ok(TeamStore.read(sessionId), "team.json 数据保留");

  setTeamUiMode(sessionId, "team");
  assert.equal(TeamStore.list()[sessionId].uiMode, "team");
});

test("deleteTeam: 删除宿主会话 + 团队数据", async (t) => {
  const root = useTempEnv(t);
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd, { recursive: true });
  const { sessionId, sessionFile } = createTeam({ cwd, name: "t" });

  await deleteTeam(sessionId);
  assert.ok(!fs.existsSync(sessionFile), "宿主会话文件已删");
  assert.equal(TeamStore.read(sessionId), null);
  assert.ok(!fs.existsSync(getTeamDir(sessionId)));
});

test("extractText: string 与 blocks 文本提取", () => {
  assert.equal(extractText("直接文本"), "直接文本");
  assert.equal(
    extractText([{ type: "text", text: "a" }, { type: "tool_call", id: "x", name: "bash", arguments: "ls" }, { type: "text", text: "b" }]),
    "a\nb",
  );
  assert.equal(extractText([{ type: "tool_call", id: "x", name: "bash", arguments: "ls" }]), "");
});
