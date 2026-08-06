import assert from "node:assert/strict";
import test from "node:test";
import { extractChangedFiles } from "./changed-files.ts";

const editCall = (path, toolCallId = "c1") => ({
  type: "toolCall",
  toolCallId,
  toolName: "edit",
  input: { path, edits: [{ oldText: "a", newText: "b" }] },
});

const writeCall = (path, toolCallId = "c2") => ({
  type: "toolCall",
  toolCallId,
  toolName: "write",
  input: { path, content: "hello" },
});

test("returns [] for empty or undefined blocks", () => {
  assert.deepEqual(extractChangedFiles(undefined), []);
  assert.deepEqual(extractChangedFiles(null), []);
  assert.deepEqual(extractChangedFiles([]), []);
});

test("extracts edit and write tool calls in order", () => {
  const blocks = [
    { type: "text", text: "Let me fix that." },
    editCall("src/a.ts", "t1"),
    writeCall("src/b.ts", "t2"),
  ];
  assert.deepEqual(extractChangedFiles(blocks), [
    { filePath: "src/a.ts", kind: "edit" },
    { filePath: "src/b.ts", kind: "write" },
  ]);
});

test("ignores non-mutation tools and non-toolCall blocks", () => {
  const blocks = [
    { type: "thinking", thinking: "hmm" },
    { type: "toolCall", toolCallId: "t1", toolName: "bash", input: { command: "npm test" } },
    { type: "toolCall", toolCallId: "t2", toolName: "read", input: { path: "src/a.ts" } },
    { type: "toolCall", toolCallId: "t3", toolName: "grep", input: { pattern: "x" } },
  ];
  assert.deepEqual(extractChangedFiles(blocks), []);
});

test("deduplicates by path, keeping first occurrence", () => {
  const blocks = [
    editCall("src/a.ts", "t1"),
    editCall("src/a.ts", "t2"),
    editCall("src/b.ts", "t3"),
  ];
  assert.deepEqual(extractChangedFiles(blocks), [
    { filePath: "src/a.ts", kind: "edit" },
    { filePath: "src/b.ts", kind: "edit" },
  ]);
});

test("normalizes backslashes and trims whitespace", () => {
  assert.deepEqual(extractChangedFiles([editCall("  src\\a.ts  ", "t1")]), [
    { filePath: "src/a.ts", kind: "edit" },
  ]);
});

test("rejects empty, non-string, and traversal paths", () => {
  const blocks = [
    editCall("", "t1"),
    editCall("   ", "t2"),
    { type: "toolCall", toolCallId: "t3", toolName: "edit", input: { path: 42 } },
    editCall("../../etc/passwd", "t4"),
    editCall("src/../secret", "t5"),
    writeCall("src/ok.ts", "t6"),
  ];
  assert.deepEqual(extractChangedFiles(blocks), [
    { filePath: "src/ok.ts", kind: "write" },
  ]);
});

test("accepts absolute paths and fallback input.filePath field", () => {
  const blocks = [
    { type: "toolCall", toolCallId: "t1", toolName: "edit", input: { filePath: "/work/src/a.ts" } },
    editCall("/work/src/b.ts", "t2"),
  ];
  assert.deepEqual(extractChangedFiles(blocks), [
    { filePath: "/work/src/a.ts", kind: "edit" },
    { filePath: "/work/src/b.ts", kind: "edit" },
  ]);
});

test("recognizes write-tool aliases", () => {
  const blocks = [
    { type: "toolCall", toolCallId: "t1", toolName: "create", input: { path: "new.txt" } },
    { type: "toolCall", toolCallId: "t2", toolName: "write_file", input: { path: "new2.txt" } },
  ];
  assert.deepEqual(extractChangedFiles(blocks), [
    { filePath: "new.txt", kind: "write" },
    { filePath: "new2.txt", kind: "write" },
  ]);
});
