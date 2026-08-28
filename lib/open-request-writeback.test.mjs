/**
 * 回归测试（2026-08-28 高频修复批次）：
 *   ① open-file-request marker 的 compare-and-delete：
 *      DELETE 带 id 只清自己消费掉的那条；窗口期内 agent 连续推送的新 marker（新 id）
 *      不被误删（旧实现无条件清 → 第二个文件永不打开）。不带 id 保留强制清旧行为。
 *   ② office-bridge 反查映射 resolveBridgeSource：给定 ai-edit .univer 产物路径
 *      返回真实原件路径（供 writeback 定位原件；旧实现按扩展名猜 → 恒 404）。
 *
 * 运行：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test lib/open-request-writeback.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// marker 路径在模块加载时经 getInternalDir() 计算 —— 必须先设 env 再 import
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-fixreg2-"));
process.env.PI_WEB_UPLOADS_DIR = dataDir;

const markerPath = path.join(dataDir, ".internal", "pi-web-open-request.json");

function writeMarker(id) {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    JSON.stringify({ id, filePath: `D:/proj/${id}.univer`, title: null, updatedAt: new Date().toISOString() }),
    "utf8",
  );
}

function delRequest(id) {
  // route 内部只访问 request.nextUrl.searchParams —— duck-typing mock 即可
  // （NextRequest 在 node --test 环境导入有兼容问题）
  const url = new URL(id ? `http://127.0.0.1:10141/api/open-file-request?id=${encodeURIComponent(id)}` : "http://127.0.0.1:10141/api/open-file-request");
  return { nextUrl: url };
}

/* ==================== ① marker compare-and-delete ==================== */

test("① DELETE 带 id 且匹配 → marker 被清除", async (t) => {
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  writeMarker("A");
  const { DELETE } = await import("../app/api/open-file-request/route.ts");
  const res = await DELETE(delRequest("A"));
  assert.equal((await res.json()).ok, true);
  assert.equal(fs.existsSync(markerPath), false, "匹配 id 的 marker 应被删除");
});

test("① DELETE 带 id 但 marker 已换新（窗口期 agent 连续推送）→ 新 marker 不被误删", async (t) => {
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  writeMarker("A"); // UI 读到 A，开始 .univer units 探测（2-3s 窗口）
  const { DELETE } = await import("../app/api/open-file-request/route.ts");
  writeMarker("B"); // 探测期间 agent 推送第二个文件
  const res = await DELETE(delRequest("A"));
  const body = await res.json();
  assert.equal(body.ok, false, "旧 id 不应命中");
  assert.equal(body.currentId, "B", "回执当前 marker id");
  assert.equal(fs.existsSync(markerPath), true, "新 marker B 必须存活（旧实现会被误删 → 文件永不打开）");
  assert.equal(JSON.parse(fs.readFileSync(markerPath, "utf8")).id, "B");
});

test("① DELETE 不带 id → 强制清（兼容 skill/agent 直接清场用法）", async (t) => {
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  writeMarker("A");
  const { DELETE } = await import("../app/api/open-file-request/route.ts");
  const res = await DELETE(delRequest(null));
  assert.equal((await res.json()).ok, true);
  assert.equal(fs.existsSync(markerPath), false);
});

/* ==================== ② office-bridge 反查映射 ==================== */

test("② resolveBridgeSource：ai-edit 产物路径 → 真实原件路径（旧实现按扩展名猜恒 404）", async (t) => {
  t.after(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });
  // 原件必须真实存在（rememberBridgeTarget 会 stat 源文件）
  const original = path.join(dataDir, "proj", "销售报表.xlsx");
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, "fake-xlsx-bytes");
  const converted = path.join(dataDir, "uploads", "销售报表-ai-edit.univer");

  const { rememberBridgeTarget, resolveBridgeSource } = await import("../lib/univer-office-bridge.ts");
  rememberBridgeTarget(original, converted);

  // 正斜杠产物路径（UI/agent 推送格式）
  const source = resolveBridgeSource(converted.replace(/\\/g, "/"));
  assert.ok(source, "注册过的产物应能反查到原件");
  assert.equal(source.replace(/\\/g, "/").toLowerCase(), original.replace(/\\/g, "/").toLowerCase(), "反查结果应为原件路径");

  // 反斜杠 + 大小写混合（Windows 风格调用）也能匹配
  assert.ok(resolveBridgeSource(converted), "反斜杠路径应同样命中");

  // 未注册的产物 → null（调用方回退同名猜测）
  assert.equal(resolveBridgeSource(path.join(dataDir, "uploads", "别的-ai-edit.univer")), null);
});
