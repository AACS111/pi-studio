import assert from "node:assert/strict";
import test from "node:test";
import { extractChangedFiles, extractGeneratedFiles, isFilePathInsideCwd } from "./changed-files.ts";

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

test("isFilePathInsideCwd handles drive letters case-insensitively", () => {
  assert.equal(isFilePathInsideCwd("C:/proj/a.ts", "C:/proj"), true);
  assert.equal(isFilePathInsideCwd("C:/proj/sub/a.ts", "c:/PROJ"), true);
  assert.equal(isFilePathInsideCwd("C:/proj2/a.ts", "C:/proj"), false);
  assert.equal(isFilePathInsideCwd("D:/proj/a.ts", "C:/proj"), false);
  assert.equal(isFilePathInsideCwd("C:/proj", "C:/proj"), true);
  assert.equal(isFilePathInsideCwd("/work/a.ts", "/work"), true);
  assert.equal(isFilePathInsideCwd("/workspace/a.ts", "/work"), false);
});

test("cwd filters out non-project (temp/scratch) files", () => {
  const blocks = [
    editCall("src/a.ts", "t1"),
    writeCall("C:/Users/x/AppData/Local/Temp/edit.mjs", "t2"),
    writeCall("C:/proj/out/report.xlsx", "t3"),
  ];
  assert.deepEqual(extractChangedFiles(blocks, "C:/proj"), [
    { filePath: "src/a.ts", kind: "edit" },
    { filePath: "C:/proj/out/report.xlsx", kind: "write" },
  ]);
  // Without a cwd nothing is filtered (backward compatible).
  assert.equal(extractChangedFiles(blocks).length, 3);
});

test("extractGeneratedFiles returns only write-kind deliverables inside cwd", () => {
  const blocks = [
    editCall("src/a.ts", "t1"),
    writeCall("C:/proj/report.xlsx", "t2"),
    writeCall("C:/proj/data.csv", "t3"),
    writeCall("C:/proj/script.mjs", "t4"),
    writeCall("C:/Users/x/AppData/Local/Temp/scratch.xlsx", "t5"),
  ];
  assert.deepEqual(extractGeneratedFiles(blocks, "C:/proj"), [
    { filePath: "C:/proj/report.xlsx", kind: "write" },
    { filePath: "C:/proj/data.csv", kind: "write" },
  ]);
});
