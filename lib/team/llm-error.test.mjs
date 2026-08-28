/** readLastAssistantLlmError 回归：空 assistant+errorMessage → 报错；有内容 → undefined；普通空回 → undefined。
 *  运行：node --import ./lib/team/node-loader.mjs --test lib/team/llm-error.test.mjs */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { readLastAssistantLlmError } = await import("./executor.ts");

test("403 余额不足（84c22d07 实锤形态）→ 返回错误信息", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmerr-"));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id: "x" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "task" } }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant", content: [], api: "openai-completions", provider: "new-provider", model: "glm-5.2",
        usage: { totalTokens: 0 }, stopReason: "error",
        errorMessage: '403: {"message":"预扣费额度失败, 用户剩余额度: ¥0.20","code":"insufficient_quota"}',
      },
    }),
  ].join("\n"), "utf8");
  const err = readLastAssistantLlmError(file);
  assert.ok(err && err.includes("预扣费额度失败"));
});

test("aborted 且仅剩 thinking 块（907d9c13 be-developer 实锤形态）→ 报错而非误判成功", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmerr-"));
  const file = path.join(dir, "abort.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "分析中…" }, { type: "toolCall", id: "t1" }], stopReason: "toolUse" } }),
    JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "结果" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "继续思考" }], stopReason: "aborted", errorMessage: "Request was aborted" } }),
  ].join("\n"));
  const err = readLastAssistantLlmError(file);
  assert.match(err ?? "", /aborted/i);
});

test("正常 assistant 有内容 → undefined；空回复无错误标记 → undefined；普通 completion 文本 → undefined", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmerr-"));
  const okFile = path.join(dir, "ok.jsonl");
  fs.writeFileSync(okFile, [
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "结论" }], stopReason: "stop" } }),
  ].join("\n"));
  assert.equal(readLastAssistantLlmError(okFile), undefined);

  const emptyFile = path.join(dir, "empty.jsonl");
  fs.writeFileSync(emptyFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "stop" } }));
  assert.equal(readLastAssistantLlmError(emptyFile), undefined);
});

test("只看最后一条 assistant：中间轮次报错但最后一轮成功 → undefined", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmerr-"));
  const file = path.join(dir, "multi.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" } }),
    JSON.stringify({ type: "message", message: { role: "user", content: "retry" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "计划已提交" }], stopReason: "toolUse" } }),
  ].join("\n"));
  assert.equal(readLastAssistantLlmError(file), undefined);

  // 反向：最后一轮报错 → 命中
  fs.writeFileSync(file, [
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
    JSON.stringify({ type: "message", message: { role: "user", content: "next" } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" } }),
  ].join("\n"));
  assert.match(readLastAssistantLlmError(file) ?? "", /boom/);
});
