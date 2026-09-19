import assert from "node:assert/strict";
import test from "node:test";
import { collectFileMutations, computeBaseline, generateNoIndexPatch } from "./session-reconstruct.ts";

// ---- 会话条目构造器（模拟 jsonl 原始形状：name/arguments，磁盘真实形状）----
let nextId = 1;
const id = () => `e${nextId++}`;
const msgEntry = (parentId, message) =>
  ({ type: "message", id: id(), parentId, timestamp: "2026-09-16T00:00:00Z", message });

const editCallBlock = (path, edits, callId) =>
  ({ type: "toolCall", id: callId, toolCallId: callId, name: "edit", arguments: { path, edits } });
const writeCallBlock = (path, content, callId) =>
  ({ type: "toolCall", id: callId, toolCallId: callId, name: "write", arguments: { path, content } });
const resultMsg = (callId, isError = false) =>
  ({ role: "toolResult", toolCallId: callId, toolName: "edit", content: [{ type: "text", text: "ok" }], isError });

test("computeBaseline: 失败的 write 之后成功 write/edit —— 失败那次不计入（在链上直接验证）", () => {
  // a1(write err) -> a2(write ok)：错误结果把 a1 槽位置空，a2 覆盖成功
  const a1 = msgEntry(null, { role: "assistant", content: [writeCallBlock("src/a.ts", "FAILED", "c1")] });
  const r1 = msgEntry(a1.id, { role: "toolResult", toolCallId: "c1", toolName: "write", content: [{ type: "text", text: "disk full" }], isError: true });
  const a2 = msgEntry(r1.id, { role: "assistant", content: [writeCallBlock("src/a.ts", "GOOD", "c2")] });
  const r2 = msgEntry(a2.id, { role: "toolResult", toolCallId: "c2", toolName: "write", content: [{ type: "text", text: "ok" }] });
  const mutations = collectFileMutations([a1, r1, a2, r2], "D:/proj", "D:/proj/src/a.ts");
  assert.equal(mutations.length, 1);
  const base = computeBaseline(mutations, "GOOD!");
  assert.ok(base.ok);
  assert.equal(base.baseline, "GOOD");
});

test("collectFileMutations: 悬空调用（执行中，结果未落盘）计入", () => {
  const a1 = msgEntry(null, { role: "assistant", content: [editCallBlock("src/a.ts", [{ oldText: "x", newText: "y" }], "c9")] });
  const entries = [a1];
  const mutations = collectFileMutations(entries, "D:/proj", "D:/proj/src/a.ts");
  assert.equal(mutations.length, 1, "流式中的调用属于本会话进行时");
});

test("collectFileMutations: 相对路径按 sessionCwd 解析、路径不匹配的跳过", () => {
  const a1 = msgEntry(null, { role: "assistant", content: [editCallBlock("src/a.ts", [{ oldText: "x", newText: "y" }], "c1")] });
  const r1 = msgEntry(a1.id, resultMsg("c1"));
  const a2 = msgEntry(r1.id, { role: "assistant", content: [writeCallBlock("D:/proj/src/other.ts", "other", "c2")] });
  const r2 = msgEntry(a2.id, { role: "toolResult", toolCallId: "c2", toolName: "write", content: [{ type: "text", text: "ok" }] });
  const entries = [a1, r1, a2, r2];

  const forA = collectFileMutations(entries, "D:/proj", "D:/proj/src/a.ts");
  assert.equal(forA.length, 1);
  assert.equal(forA[0].kind, "edit", "相对路径命中目标文件");

  const forOther = collectFileMutations(entries, "D:/proj", "D:/proj/src/other.ts");
  assert.equal(forOther.length, 1);
  assert.equal(forOther[0].kind, "write", "绝对路径命中");
});

test("collectFileMutations: 只取当前分支（旁支条目跳过）", () => {
  // 主链 a1 -> r1 -> a2 -> r2；旁支在 r1 后分叉（b1 -> b2），tip 是主链。
  const a1 = msgEntry(null, { role: "assistant", content: [editCallBlock("src/a.ts", [{ oldText: "x", newText: "y" }], "c1")] });
  const r1 = msgEntry(a1.id, resultMsg("c1"));
  const b1 = msgEntry(r1.id, { role: "assistant", content: [writeCallBlock("src/a.ts", "from-branch", "cb")] }); // 会被分叉
  const b2 = msgEntry(b1.id, { role: "toolResult", toolCallId: "cb", toolName: "write", content: [{ type: "text", text: "ok" }] });
  const a2 = msgEntry(r1.id, { role: "assistant", content: [editCallBlock("src/a.ts", [{ oldText: "y", newText: "z" }], "c2")] });
  const r2 = msgEntry(a2.id, resultMsg("c2"));
  // deliberately push them out of order (jsonl 是追加序，分支后新链附在文件尾)
  const entries = [a1, r1, b1, b2, a2, r2];

  const mutations = collectFileMutations(entries, "D:/proj", "D:/proj/src/a.ts");
  assert.equal(mutations.length, 2, "旁支 write 不计入，主链两个 edit 计入");
  assert.equal(mutations[0].edits[0].newText, "y");
  assert.equal(mutations[1].edits[0].newText, "z");
});

test("computeBaseline: 两条 edit 逆序撤销还原到基线", () => {
  const mutations = [
    { kind: "edit", edits: [{ oldText: "hello", newText: "hello world" }] },
    { kind: "edit", edits: [{ oldText: "!", newText: "!!!" }] },
  ];
  const current = "hello world!!!";
  const r = computeBaseline(mutations, current);
  assert.ok(r.ok);
  assert.equal(r.baseline, "hello!");
});

test("computeBaseline: 同一调用多条替换（edits 数组）按调用内倒序撤销", () => {
  const mutations = [
    { kind: "edit", edits: [
      { oldText: "aa", newText: "AA" },
      { oldText: "bb", newText: "BB" },
    ] },
  ];
  const r = computeBaseline(mutations, "AA BB");
  assert.ok(r.ok);
  assert.equal(r.baseline, "aa bb");
});

test("computeBaseline: newText 不唯一（bash 漂移）时安全失败", () => {
  const mutations = [
    { kind: "edit", edits: [{ oldText: "one", newText: "two" }] },
  ];
  // 当前内容里 "two" 出现两次 → 无法确定撤销哪一个
  const r = computeBaseline(mutations, "two and two");
  assert.equal(r.ok, false);
});

test("computeBaseline: newText 出现 0 次（内容又被改掉）时安全失败", () => {
  const mutations = [
    { kind: "edit", edits: [{ oldText: "one", newText: "two" }] },
  ];
  const r = computeBaseline(mutations, "completely different");
  assert.equal(r.ok, false);
});

test("computeBaseline: 首 write = 新建文件，基线为 write 内容", () => {
  const r = computeBaseline([{ kind: "write", content: "line1\nline2\n" }], "line1\nline2\nline3\n");
  assert.ok(r.ok);
  assert.equal(r.baseline, "line1\nline2\n", "后续迭代（line3）成为 diff");
});

test("computeBaseline: write 后再 edit → 回退到 write 内容", () => {
  const mutations = [
    { kind: "write", content: "v1\n" },
    { kind: "edit", edits: [{ oldText: "v1", newText: "v2" }] },
  ];
  const r = computeBaseline(mutations, "v2\n");
  assert.ok(r.ok);
  assert.equal(r.baseline, "v1\n");
});

test("computeBaseline: CRLF 规范化（磁盘 CRLF / edit LF）", () => {
  const mutations = [
    { kind: "edit", edits: [{ oldText: "a\r\nb", newText: "c\r\nb" }] },
  ];
  const r = computeBaseline(mutations, "c\nb");
  assert.ok(r.ok);
  assert.equal(r.baseline, "a\nb");
});

test("computeBaseline: 空数组安全失败", () => {
  assert.equal(computeBaseline([], "x").ok, false);
});

test("generateNoIndexPatch: 生成标准 unified diff 并含 @@ 头", async () => {
  const patch = await generateNoIndexPatch("line1\nline2\n", "line1\nLINE2\nline3\n");
  assert.ok(patch);
  assert.match(patch, /^@@ -1,2 \+1,3 @@/m);
  assert.match(patch, /^-line2$/m);
  assert.match(patch, /^\+LINE2$/m);
  assert.match(patch, /^\+line3$/m);
});

test("generateNoIndexPatch: 内容相同返回 null", async () => {
  assert.equal(await generateNoIndexPatch("same\n", "same\n"), null);
});

test("端到端回环：edit 链 → 磁盘 → 基线 → patch", async () => {
  // 模拟一次真实会话：两个 edit 调用改同一文件
  const a1 = msgEntry(null, { role: "assistant", content: [editCallBlock("src/svc.java", [
    { oldText: "import java.util.List;", newText: "import java.util.List;\nimport java.util.Map;" },
  ], "c1")] });
  const r1 = msgEntry(a1.id, resultMsg("c1"));
  const a2 = msgEntry(r1.id, { role: "assistant", content: [editCallBlock("src/svc.java", [
    { oldText: "public class Svc {}", newText: "public class Svc {\n  void run() {}\n}" },
  ], "c2")] });
  const r2 = msgEntry(a2.id, resultMsg("c2"));
  const entries = [a1, r1, a2, r2];

  const mutations = collectFileMutations(entries, "D:/proj", "D:/proj/src/svc.java");
  const disk = "import java.util.List;\nimport java.util.Map;\n\npublic class Svc {\n  void run() {}\n}\n";
  const baseline = computeBaseline(mutations, disk);
  assert.ok(baseline.ok, "可完整回退");
  assert.equal(baseline.baseline, "import java.util.List;\n\npublic class Svc {}\n");

  const patch = await generateNoIndexPatch(baseline.baseline, disk);
  assert.ok(patch);
  assert.match(patch, /^\+import java\.util\.Map;$/m);
  assert.match(patch, /^\+  void run\(\) \{\}$/m);
  assert.doesNotMatch(patch, /^-import java\.util\.List;$/m, "未删 import List");
});
