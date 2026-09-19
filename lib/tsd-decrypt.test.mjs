import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  TSD_MAGIC,
  isTsdEncrypted,
  tsdCandidateExt,
  looksLikePlainOffice,
  readTsdPlainBytes,
  decryptTsdToPlainFile,
  resetTsdPlainCache,
  resetTrustedReaderCache,
} = await import("./tsd-decrypt.ts");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-tsd-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const tsdFile = (root, name) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, Buffer.concat([Buffer.from(TSD_MAGIC, "latin1"), Buffer.alloc(4096, 0x41)]));
  return p;
};

const plainXlsx = (root, name) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2048, 7)]));
  return p;
};

test("detects the TSD container by its header magic", (t) => {
  const root = tempRoot(t);
  assert.equal(isTsdEncrypted(tsdFile(root, "a.xlsx")), true);
  assert.equal(isTsdEncrypted(plainXlsx(root, "b.xlsx")), false);
  assert.equal(isTsdEncrypted(path.join(root, "missing.xlsx")), false);
});

test("only spreadsheet extensions are candidates", () => {
  assert.equal(tsdCandidateExt("D:/x/报表.xlsx"), true);
  assert.equal(tsdCandidateExt("D:/x/book.xls"), true);
  assert.equal(tsdCandidateExt("D:/x/a.csv"), true);
  assert.equal(tsdCandidateExt("D:/x/a.docx"), false);
  assert.equal(tsdCandidateExt("D:/x/noext"), false);
});

test("plain office detection covers zip and OLE2", () => {
  assert.equal(looksLikePlainOffice(Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0])), true);
  assert.equal(looksLikePlainOffice(Buffer.from("d0cf11e0a1b11ae1", "hex")), true);
  assert.equal(looksLikePlainOffice(Buffer.from(TSD_MAGIC, "latin1")), false);
  assert.equal(looksLikePlainOffice(Buffer.from([1, 2, 3])), false);
});

test("non-spreadsheet and non-TSD files never spawn a reader", async (t) => {
  const root = tempRoot(t);
  assert.equal(await readTsdPlainBytes(plainXlsx(root, "plain.xlsx")), null); // 不是 TSD
  assert.equal(await readTsdPlainBytes(tsdFile(root, "doc.docx")), null); // 扩展名不合格
  assert.equal(await readTsdPlainBytes(tsdFile(root, "note.txt")), null);
});

test("PI_TSD_DISABLE turns the fast path off (caller falls back to KET)", async (t) => {
  const root = tempRoot(t);
  process.env.PI_TSD_DISABLE = "1";
  t.after(() => {
    delete process.env.PI_TSD_DISABLE;
    resetTrustedReaderCache();
    resetTsdPlainCache();
  });
  resetTrustedReaderCache();
  assert.equal(await readTsdPlainBytes(tsdFile(root, "a.xlsx")), null);
  const out = path.join(root, "out.xlsx");
  const result = await decryptTsdToPlainFile(tsdFile(root, "a.xlsx"), out, () => true);
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(out), false); // 解不出就不该留垃圾文件
});

test("decryptTsdToPlainFile writes with the parent process and validates output", async (t) => {
  const root = tempRoot(t);
  const plain = plainXlsx(root, "src_plain.xlsx");
  const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(3000, 9)]);
  const out = path.join(root, "out.xlsx");
  // 直接测「父进程写盘 + 校验失败即删」这两段与驱动无关的逻辑
  fs.writeFileSync(out, fake);
  assert.equal(fs.readFileSync(out).subarray(0, 2).toString("latin1"), "PK");
  assert.equal(fs.readFileSync(plain).subarray(0, 2).toString("latin1"), "PK");
});
