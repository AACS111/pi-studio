import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { shouldPasteAsFile, pastedTextFileName } = await jiti.import("./ChatInput.tsx");

test("short pastes stay in the textarea", () => {
  assert.equal(shouldPasteAsFile(""), false);
  assert.equal(shouldPasteAsFile("hello world"), false);
  assert.equal(shouldPasteAsFile("a".repeat(1199)), false);
  assert.equal(shouldPasteAsFile(Array.from({ length: 23 }, () => "x").join("\n")), false);
});

test("long pastes become file attachments", () => {
  assert.equal(shouldPasteAsFile("a".repeat(1200)), true);
  // 24 行（23 个换行）刚好到阈值
  assert.equal(shouldPasteAsFile(Array.from({ length: 24 }, () => "x").join("\n")), true);
});

test("pasted file names are readable and filesystem safe", () => {
  const name = pastedTextFileName("# 需求：修复 <登录> 卡顿\n后面还有内容", new Date(2026, 8, 12, 15, 4, 5));
  assert.match(name, /^pasted-.*-20260912-150405\.txt$/);
  assert.ok(!/[\\/:*?"<>|#%&]/.test(name), name);
  assert.ok(name.length < 60, name);
});

test("pasted file names fall back when the first line is empty", () => {
  const name = pastedTextFileName("\n\nbody", new Date(2026, 0, 2, 3, 4, 5));
  assert.equal(name, "pasted-20260102-030405.txt");
});
