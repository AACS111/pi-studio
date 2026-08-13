import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./browser-proxy.ts");
}

test("normalizeUserUrl adds https and validates schemes", async () => {
  const { normalizeUserUrl } = await loadSubject();
  assert.equal(normalizeUserUrl("example.com"), "https://example.com/");
  assert.equal(normalizeUserUrl("example.com/path?a=1"), "https://example.com/path?a=1");
  assert.equal(normalizeUserUrl("http://localhost:5173"), "http://localhost:5173/");
  assert.equal(normalizeUserUrl("https://x.io"), "https://x.io/");
  assert.equal(normalizeUserUrl("ftp://x.io"), null);
  assert.equal(normalizeUserUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUserUrl("  "), null);
  assert.equal(normalizeUserUrl(""), null);
});
