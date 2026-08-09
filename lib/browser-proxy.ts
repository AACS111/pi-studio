/**
 * Shared helpers for pi-studio's right-panel browser (web preview).
 *
 * The browser tab loads every page through a server-side proxy
 * (`/api/browser/proxy`) instead of embedding the target origin directly:
 *  - many sites refuse to be iframed via X-Frame-Options / CSP frame-ancestors,
 *    and a server fetch can strip those headers;
 *  - the iframe then stays on the pi-studio origin (sandboxed, no allow-same-origin)
 *    so a loaded page can never read pi-studio's own API/cookies.
 *
 * The proxy rewrites the HTML it returns so every subresource (scripts, styles,
 * images, links, forms, meta-refresh) keeps flowing through the proxy, which is
 * what makes relative/absolute URLs work inside a sandboxed iframe.
 */

export const PROXY_PATH = "/api/browser/proxy";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Scheme prefixes that must never go through the proxy. */
const LEAVE_AS_IS = new Set([
  "data:",
  "javascript:",
  "mailto:",
  "tel:",
  "sms:",
  "blob:",
  "about:",
  "irc:",
  "file:",
  "ftp:",
  "ws:",
  "wss:",
  "geo:",
]);

/**
 * Normalize a user-typed / agent-provided address into an absolute http(s)
 * URL, or null when it is empty or not a web address. Adds "https://" when no
 * scheme is present (e.g. "example.com/page" or "localhost:5173").
 */
export function normalizeUserUrl(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  let candidate = raw;
  // Bare hostname / host:port / path → assume https.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    candidate = "https://" + candidate;
  }
  try {
    const url = new URL(candidate);
    if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Proxy URL that loads `targetUrl` inside the web-preview iframe.
 *
 * 路径式（不是 ?url= query）：
 *   /api/browser/proxy/<b64(base)>/<relpath>
 * 其中 base = 目标 URL 的 origin + 目录（以 / 结尾），b64 = base64url(base)，
 * relpath = 资源相对 base 的路径。
 *
 * 为什么必须路径式：Vite/Webpack 的**动态 import 相对路径 chunk**（如
 * `import("./univer-themes.abc.js")`）基于 import.meta.url 解析。query 式
 * 代理下 import.meta.url = /api/browser/proxy?url=...，目录是 /api/browser/，
 * 相对导入就落到 /api/browser/univer-themes.js → 404 + opaque-origin CORS。
 * 路径式下目录里带着编码的页面 base，相对导入能推导回代理正确转发。
 */
export function proxyTargetUrl(targetUrl: string): string {
  const u = new URL(targetUrl);
  // base = origin + 目录（文件名之前的路径，含结尾 /）
  const lastSlash = u.pathname.lastIndexOf("/");
  const dir = lastSlash === -1 ? "/" : u.pathname.slice(0, lastSlash + 1);
  const base = u.origin + dir;
  const rel = u.pathname.slice(dir.length);
  return `${PROXY_PATH}/${b64urlEncode(base)}/${rel}${u.search}${u.hash}`;
}

/**
 * 浏览器/Node 通用 base64url 编码（无 = 填充）。
 *
 * 注意：打包进浏览器的 Buffer 是 buffer npm 包的 polyfill（由某些依赖触发
 * Turbopack/Webpack 注入），它不认识 base64url 编码——`typeof Buffer !==
 * "undefined"` 在浏览器里也是 true，直接 toString("base64url") 会抛
 * `Unknown encoding: base64url`。所以用 try/catch 兜底，失败就走 btoa 路径。
 */
export function b64urlEncode(input: string): string {
  if (typeof Buffer !== "undefined") {
    try {
      return Buffer.from(input, "utf8").toString("base64url");
    } catch {
      /* buffer polyfill 不支持 base64url — 落到下面浏览器路径 */
    }
  }
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 浏览器/Node 通用 base64url 解码。 */
export function b64urlDecode(input: string): string {
  if (typeof Buffer !== "undefined") {
    try {
      return Buffer.from(input, "base64url").toString("utf8");
    } catch {
      /* buffer polyfill 不支持 base64url — 落到下面浏览器路径 */
    }
  }
  const pad = input.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 从代理 URL（路径式或旧 query 式）解析出真实目标 URL，失败返回 null。 */
export function parseProxyTarget(proxyUrl: string): string | null {
  try {
    const u = new URL(proxyUrl, "http://localhost");
    if (u.pathname.startsWith(PROXY_PATH + "/")) {
      const rest = u.pathname.slice(PROXY_PATH.length); // /<b64>/{rel}
      const m = rest.match(/^\/([A-Za-z0-9_-]+)(\/?.*)$/);
      if (m) {
        const base = b64urlDecode(m[1]);
        // 相对路径拼接（base 以 / 结尾；m[2] 前导 / 去掉，空/单斜杠=目录本身）
        const rel = (m[2] ?? "").replace(/^\//, "");
        const target = new URL(rel || ".", base);
        target.search = u.search;
        target.hash = u.hash;
        return ALLOWED_SCHEMES.has(target.protocol) ? target.href : null;
      }
    }
    const q = u.searchParams.get("url");
    if (q) return normalizeUserUrl(q);
  } catch {
    /* fallthrough */
  }
  return null;
}

/** Whether a URL string already points back at our own proxy. */
export function isProxiedUrl(value: string): boolean {
  return value.startsWith(PROXY_PATH);
}

/**
 * Resolve an attribute value found inside a page (relative or absolute)
 * against the page URL. Returns an absolute http(s) URL to load through the
 * proxy, or null when the value must be left untouched (same-page anchors,
 * data:/mailto:/javascript: and friends).
 */
export function resolveAttributeUrl(value: string, pageUrl: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (raw.startsWith("#")) return null;
  const lower = raw.toLowerCase();
  for (const scheme of LEAVE_AS_IS) {
    if (lower.startsWith(scheme)) return null;
  }
  try {
    // Handles protocol-relative "//host/path" (inherits page protocol) too.
    return new URL(raw, pageUrl).href;
  } catch {
    return null;
  }
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

/** Rewrite url(...) references inside CSS (inline styles or <style> bodies). */
export function rewriteCssUrls(css: string, pageUrl: string): string {
  return css.replace(CSS_URL_RE, (match, quote: string, raw: string) => {
    const inner = raw.trim();
    if (!inner || isProxiedUrl(inner)) return match;
    const resolved = resolveAttributeUrl(inner, pageUrl);
    if (!resolved) return match;
    return `url(${quote}${proxyTargetUrl(resolved)}${quote})`;
  });
}

const URL_ATTRS = new Set([
  "src",
  "href",
  "action",
  "poster",
  "cite",
  "formaction",
  "data-src",
  "data-href",
  "data-original",
  "data-url",
  "data-lazy-src",
  "data-srcset",
  "srcset",
]);

// Matches a single attribute assignment: name="value" | name='value' | name=bare
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function rewriteAttrValue(attrName: string, value: string, pageUrl: string): string {
  if (!value || isProxiedUrl(value)) return value;
  if (attrName === "srcset" || attrName === "data-srcset") {
    return value
      .split(",")
      .map((part) => {
        const p = part.trim();
        if (!p || /^data:/i.test(p)) return part;
        const splitAt = p.search(/\s/);
        const urlPart = splitAt === -1 ? p : p.slice(0, splitAt);
        const rest = splitAt === -1 ? "" : p.slice(splitAt);
        const resolved = resolveAttributeUrl(urlPart, pageUrl);
        return resolved ? `${proxyTargetUrl(resolved)}${rest}` : part;
      })
      .join(",");
  }
  const resolved = resolveAttributeUrl(value, pageUrl);
  return resolved ? proxyTargetUrl(resolved) : value;
}

/**
 * Rewrite an HTML document so every URL (attributes, meta refresh, inline and
 * <style> CSS) flows through the proxy, and strip headers-driven blockers that
 * would otherwise prevent embedding (they live in response headers, which the
 * proxy already removes, but some pages also declare <base href> or a meta
 * Content-Security-Policy — both are neutralized here).
 *
 * Only actual tag contents are touched; <script>/<style> text bodies are
 * skipped by the attribute pass (they are not inside a tag) so JavaScript
 * string literals like `href = "https://..."` are never corrupted.
 */
export function rewriteHtmlDocument(html: string, pageUrl: string): string {
  let out = html.replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    // <base href> would hijack any untouched relative URL — drop it.
    if (/^<base\b/i.test(tag)) return "";
    // Meta CSP would re-lock the page after the response-header strip.
    if (/^<meta\b[^>]*http-equiv=["']?content-security-policy/i.test(tag)) return "";
    // <meta http-equiv="refresh" content="0; url=/path">
    if (/^<meta\b[^>]*http-equiv=["']?refresh/i.test(tag)) {
      tag = tag.replace(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i, (m, dq: string, sq: string) => {
        const value = dq ?? sq ?? "";
        const rewritten = value.replace(
          /(url\s*=\s*)(["']?)([^"';\s>]+)/i,
          (uMatch, pre: string, quote: string, urlRaw: string) => {
            const resolved = resolveAttributeUrl(urlRaw, pageUrl);
            if (!resolved) return uMatch;
            return `${pre}${quote}${proxyTargetUrl(resolved)}`;
          },
        );
        const quote = dq !== undefined ? '"' : "'";
        return `content=${quote}${rewritten}${quote}`;
      });
    }
    // Rewrite URL-bearing attributes (and inline style url()).
    return tag.replace(ATTR_RE, (match, name: string, dq: string, sq: string, bare: string) => {
      const lname = name.toLowerCase();
      if (lname === "style") {
        const value = dq ?? sq ?? bare ?? "";
        const rewritten = rewriteCssUrls(value, pageUrl);
        if (rewritten === value) return match;
        const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
        return `${name}=${quote}${rewritten}${quote}`;
      }
      if (!URL_ATTRS.has(lname)) return match;
      const value = dq ?? sq ?? bare ?? "";
      const rewritten = rewriteAttrValue(lname, value, pageUrl);
      if (rewritten === value) return match;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
      return `${name}=${quote}${rewritten}${quote}`;
    });
  });

  // 强制 <a> 链接在 iframe 内导航：把 target="_blank/_parent/_top" 改为 _self，
  // 否则配沙箱 allow-popups-to-escape-sandbox 会跳出到真实浏览器新标签页。
  out = out.replace(/<a\b[^>]*>/gi, (tag) => {
    if (!/target\s*=/i.test(tag)) return tag;
    return tag.replace(/target\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (m, dq: string, sq: string) => {
      const value = (dq ?? sq ?? "").toLowerCase().trim();
      if (!value || value === "_self") return m;
      return 'target="_self"';
    });
  });

  // Rewrite url() inside <style> blocks (their bodies are text between tags).
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (match, body: string) => {
    const rewritten = rewriteCssUrls(body, pageUrl);
    return rewritten === body ? match : match.replace(body, rewritten);
  });

  // 沙箱 iframe 里 localStorage/sessionStorage 不可用（SecurityError），
  // 很多应用（如 Vben Admin）启动即读取并崩溃——注入内存 shim。
  out = injectSandboxStorageShim(out);

  return out;
}

/**
 * 沙箱 iframe（无 allow-same-origin → opaque origin）中访问
 * window.localStorage / sessionStorage 会抛 SecurityError。为让被预览的应用
 * 能正常启动，在页面最顶部注入一个内存版 Storage shim：真实存储可用时
 * （非沙箱环境）完全不动；不可用时用 Map 实现替代，应用读写不报错。
 */
const SANDBOX_STORAGE_SHIM_BODY = `(function () {
  function makeStore() {
    var m = Object.create(null);
    var order = [];
    function touch(k) { var i = order.indexOf(k); if (i >= 0) order.splice(i, 1); order.push(k); }
    return {
      get length() { return order.length; },
      key: function (i) { return i >= 0 && i < order.length ? order[i] : null; },
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) {
        k = String(k); v = String(v);
        if (!Object.prototype.hasOwnProperty.call(m, k)) touch(k);
        m[k] = v;
      },
      removeItem: function (k) {
        k = String(k);
        if (Object.prototype.hasOwnProperty.call(m, k)) {
          delete m[k];
          var i = order.indexOf(k); if (i >= 0) order.splice(i, 1);
        }
      },
      clear: function () { for (var k in m) delete m[k]; order.length = 0; }
    };
  }
  function install(name) {
    try {
      var probe = "__pw_shim_probe__";
      window[name].setItem(probe, "1");
      window[name].removeItem(probe);
      return; // 真实现可用（非沙箱环境）——不覆盖
    } catch (e) { /* opaque origin：读取属性本身就抛 SecurityError */ }
    var store = makeStore();
    try {
      Object.defineProperty(window, name, { value: store, configurable: true, writable: true });
    } catch (e) {
      try { window[name] = store; } catch (e2) { /* 无能为力，保持原样 */ }
    }
  }
  install("localStorage");
  install("sessionStorage");
})();`;

/** 在 HTML 最顶部注入沙箱存储 shim（head 之后 / doctype 之后，保持标准模式）。 */
export function injectSandboxStorageShim(html: string): string {
  const shim = `<script>${SANDBOX_STORAGE_SHIM_BODY}</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + shim + html.slice(at);
  }
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype.index + doctype[0].length;
    return html.slice(0, at) + shim + html.slice(at);
  }
  return shim + html;
}
