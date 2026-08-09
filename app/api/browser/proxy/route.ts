import { NextRequest, NextResponse } from "next/server";
import {
  parseProxyTarget,
  rewriteCssUrls,
  rewriteHtmlDocument,
} from "@/lib/browser-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 所有代理响应都带 ACAO:* —— 沙箱 iframe（无 allow-same-origin，opaque origin）里
// 子资源请求会被 Chrome 的 ORB（Opaque Response Blocking）拦截，除非响应带
// Access-Control-Allow-Origin。pi-studio 自身的 API 路由没有 CORS 头，所以即使
// iframe 里是恶意页面也无法读取 pi-studio 的数据。
const COMMON_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
};

const FETCH_TIMEOUT_MS = 20000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_CSS_BYTES = 4 * 1024 * 1024;
const MAX_FORM_BYTES = 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 pi-web-browser/1.0";

/**
 * Server-side web proxy for the right-panel browser tab.
 *
 * GET /api/browser/proxy?url=<encoded>
 *   Fetches the target page and returns it with X-Frame-Options / CSP removed
 *   and every URL rewritten to flow through the proxy again, so arbitrary
 *   sites render inside the sandboxed iframe. Non-HTML responses (images,
 *   scripts, styles, …) are streamed through untouched.
 *
 * POST /api/browser/proxy?url=<encoded>
 *   Forwards the (urlencoded) form body to the target — <form action> is
 *   rewritten to point here, so pages with forms keep working.
 */
function errorPage(status: number, title: string, detail: string): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#334155;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="text-align:center;padding:24px;max-width:420px">
  <div style="font-size:34px;margin-bottom:12px">🌐</div>
  <div style="font-size:16px;font-weight:600;margin-bottom:6px">${escapeHtml(title)}</div>
  <div style="font-size:13px;line-height:1.6;opacity:.8">${escapeHtml(detail)}</div>
</div></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...COMMON_HEADERS,
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeHtml(bytes: ArrayBuffer, contentType: string): string {
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function handle(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;
  // 路径式：/api/browser/proxy/<b64(base)>/<relpath>?query
  // 旧格式兼容：/api/browser/proxy?url=<encoded>&check=1
  const target = parseProxyTarget(request.nextUrl.href);
  if (!target) {
    return errorPage(400, "Invalid URL", "Enter a valid http(s) address.");
  }

  // GET 表单会把字段追加到（已重写的）action URL 上——重新拼回上游请求。
  // 注意跳过内部参数 url / check（check 只是预检标记，不能泄漏给上游）。
  const upstreamUrl = new URL(target);
  params.forEach((value, key) => {
    if (key === "url" || key === "check") return;
    upstreamUrl.searchParams.set(key, value);
  });

  const method = request.method === "POST" ? "POST" : "GET";
  let body: string | null = null;
  if (method === "POST") {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("application/x-www-form-urlencoded")) {
      return errorPage(415, "Form not supported", "Only urlencoded forms are forwarded through the preview proxy.");
    }
    const text = await request.text();
    if (text.length > MAX_FORM_BYTES) {
      return errorPage(413, "Form too large", "The submitted form exceeds the preview limit.");
    }
    body = text;
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": USER_AGENT,
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
      },
    });
  } catch (error) {
    const detail =
      error instanceof DOMException && error.name === "TimeoutError"
        ? `The page did not respond within ${Math.round(FETCH_TIMEOUT_MS / 1000)}s.`
        : String(error);
    return errorPage(502, "Could not load page", detail);
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const status = upstream.status;
  const finalUrl = upstream.url || upstreamUrl.href;

  // ?check=1：只返回能否加载（不读 body），供前端判断是否切换到 Agent 控制台。
  if (params.get("check") === "1") {
    try {
      await upstream.body?.cancel();
    } catch { /* 忽略 */ }
    return NextResponse.json({
      ok: status >= 200 && status < 300,
      status,
      contentType: contentType.split(";")[0].trim(),
      url: finalUrl,
    }, { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });
  }

  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    const declared = Number(upstream.headers.get("content-length") ?? "0");
    if (declared > MAX_HTML_BYTES) {
      return errorPage(413, "Page too large", "This page exceeds the preview size limit (8 MB).");
    }
    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > MAX_HTML_BYTES) {
      return errorPage(413, "Page too large", "This page exceeds the preview size limit (8 MB).");
    }
    const html = decodeHtml(buffer, contentType);
    const rewritten = rewriteHtmlDocument(html, finalUrl);
    return new Response(rewritten, {
      status,
      headers: {
        "content-type": contentType,
        ...COMMON_HEADERS,
        "x-robots-tag": "noindex",
        // No X-Frame-Options / CSP on purpose — the sandboxed iframe is the
        // only place this content is rendered.
      },
    });
  }

  // 外部 CSS：重写 url(...)（背景图/字体等），否则浏览器会相对代理 URL 解析导致 404。
  if (/text\/css/i.test(contentType)) {
    const declared = Number(upstream.headers.get("content-length") ?? "0");
    if (declared > MAX_CSS_BYTES) {
      return errorPage(413, "Stylesheet too large", "This stylesheet exceeds the preview size limit.");
    }
    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > MAX_CSS_BYTES) {
      return errorPage(413, "Stylesheet too large", "This stylesheet exceeds the preview size limit.");
    }
    const css = decodeHtml(buffer, contentType);
    const rewritten = rewriteCssUrls(css, finalUrl);
    return new Response(rewritten, {
      status,
      headers: {
        "content-type": contentType,
        ...COMMON_HEADERS,
        "x-robots-tag": "noindex",
      },
    });
  }

  // 其余子资源（图片、字体、脚本、媒体……）原样透传，但必须带 ACAO:*（ORB）。
  return new Response(upstream.body, {
    status,
    headers: {
      "content-type": contentType,
      ...COMMON_HEADERS,
    },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  return handle(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return handle(request);
}
