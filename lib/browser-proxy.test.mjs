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

test("proxyTargetUrl round-trips through the proxy path", async () => {
  const { proxyTargetUrl, isProxiedUrl } = await loadSubject();
  const proxied = proxyTargetUrl("https://example.com/a?b=c");
  assert.ok(proxied.startsWith("/api/browser/proxy?url="));
  assert.ok(isProxiedUrl(proxied));
  assert.ok(!isProxiedUrl("https://example.com"));
});

test("resolveAttributeUrl handles relative, absolute, protocol-relative and leaves special schemes", async () => {
  const { resolveAttributeUrl } = await loadSubject();
  const page = "https://example.com/dir/page.html";
  assert.equal(resolveAttributeUrl("style.css", page), "https://example.com/dir/style.css");
  assert.equal(resolveAttributeUrl("/root.js", page), "https://example.com/root.js");
  assert.equal(resolveAttributeUrl("https://cdn.io/x.js", page), "https://cdn.io/x.js");
  assert.equal(resolveAttributeUrl("//cdn.io/x.js", page), "https://cdn.io/x.js");
  assert.equal(resolveAttributeUrl("#anchor", page), null);
  assert.equal(resolveAttributeUrl("data:image/png;base64,AAA", page), null);
  assert.equal(resolveAttributeUrl("mailto:a@b.c", page), null);
  assert.equal(resolveAttributeUrl("javascript:void(0)", page), null);
});

test("rewriteHtmlDocument rewrites URLs, strips base/meta-CSP and never touches script bodies", async () => {
  const { rewriteHtmlDocument } = await loadSubject();
  const page = "https://example.com/dir/page.html";
  const html = `<!doctype html>
<html>
<head>
<base href="https://evil.example/">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<link rel="stylesheet" href="../css/main.css">
<script src="https://cdn.example/lib.js"></script>
<script>const href = "https://unrelated.example/keep-me";</script>
</head>
<body>
<a href="/next">Next</a>
<img src="pic.png" srcset="pic-2x.png 2x, pic-3x.png 3x">
<div style="background:url('../img/bg.png')"></div>
<style>body { background-image: url("sprite.png"); }</style>
<form action="/submit"><input name="q"></form>
<script>document.title = "kept";</script>
</body>
</html>`;
  const out = rewriteHtmlDocument(html, page);

  // base tag removed
  assert.ok(!out.includes("evil.example"));
  // meta CSP removed
  assert.ok(!out.includes("content-security-policy"));
  // attribute URLs proxied
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/css/main.css")));
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://cdn.example/lib.js")));
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/next")));
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/dir/pic.png")));
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/dir/pic-2x.png")));
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/dir/pic-3x.png")));
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/img/bg.png")));
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/dir/sprite.png")));
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/submit")));
  // script bodies untouched (JS string literals preserved)
  assert.ok(out.includes("https://unrelated.example/keep-me"));
  assert.ok(out.includes("document.title = \"kept\";"));
  // idempotent — a second pass must not double-wrap
  const twice = rewriteHtmlDocument(out, page);
  assert.ok(!twice.includes("/api/browser/proxy?url=" + encodeURIComponent("/api/browser/proxy")));
});

test("rewriteHtmlDocument forces target=_blank links to _self so the preview stays in the iframe", async () => {
  const { rewriteHtmlDocument } = await loadSubject();
  const html = `<a href="/next" target="_blank">next</a><a href="/top" target="_top">top</a><a href="/self" target="_self">self</a><a href="/none">none</a>`;
  const out = rewriteHtmlDocument(html, "https://example.com/a");
  assert.ok(out.includes(`target="_self"`));
  assert.ok(!out.includes("_blank"));
  assert.ok(!out.includes("_top"));
  // href 仍然被重写到代理
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/next")));
});

test("rewriteCssUrls rewrites url() in standalone stylesheets against the css url", async () => {
  const { rewriteCssUrls } = await loadSubject();
  const css = `#a { background: url(../img/bg.png) no-repeat; }
@font-face { src: url("/fonts/x.woff2") format("woff2"); }
.keep { background: url(data:image/png;base64,AAA); }`;
  const out = rewriteCssUrls(css, "https://example.com/css/style.css");
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/img/bg.png")));
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/fonts/x.woff2")));
  assert.ok(out.includes("data:image/png;base64,AAA"));
  // idempotent
  const twice = rewriteCssUrls(out, "https://example.com/css/style.css");
  assert.equal(twice, out);
});

test("rewriteHtmlDocument handles meta refresh and stays safe on non-tag content", async () => {
  const { rewriteHtmlDocument } = await loadSubject();
  const out = rewriteHtmlDocument(
    `<meta http-equiv="refresh" content="0; url=/moved">`,
    "https://example.com/a",
  );
  assert.ok(out.includes('/api/browser/proxy?url=' + encodeURIComponent("https://example.com/moved")));

  // Bare text that looks like an attribute must not be touched.
  const text = "text = \"https://example.com/plain\" is not an attribute";
  assert.equal(rewriteHtmlDocument(text, "https://example.com/"), text);
});
