import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIDECAR_BASE = process.env.PI_BROWSER_USE_BASE_URL ?? "http://127.0.0.1:17865";
const SIDECAR_TIMEOUT_MS = 300000; // /agent 任务可能跑几分钟

type RouteContext = { params: Promise<{ path: string[] }> | { path: string[] } };

/**
 * pi-studio → browser-use 侧车的同源代理。
 *
 * 浏览器页面无法直连侧车（127.0.0.1:17865，无 CORS），通过本路由同源转发，
 * 让右侧面板的「Agent 控制台」视图可以轮询截图/URL/内容。
 *
 * GET  /api/browser/control/content|screenshot|url|health?...
 * POST /api/browser/control/open|click|type|press|scroll|back|forward|reload|agent|close
 */
async function forward(request: NextRequest, pathSegments: string[]) {
  if (pathSegments.length === 0) {
    return NextResponse.json({ error: "missing sidecar path" }, { status: 400 });
  }
  const path = pathSegments.join("/");
  const url = new URL(`/${path}`, SIDECAR_BASE);
  url.search = request.nextUrl.search;

  const method = request.method;
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
      headers: {
        accept: request.headers.get("accept") ?? "*/*",
        "content-type": request.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    const detail =
      error instanceof DOMException && error.name === "TimeoutError"
        ? "browser-use sidecar timed out"
        : "browser-use sidecar unreachable — start it with tools/browser-use-server/start.bat";
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  // 直接透传响应体流（不缓冲）——SSE 推流（/screencast）必须流式转发，否则会被
  // arrayBuffer() 整体读完后才返回，实时镜像就卡死了。
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  return forward(request, path);
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  return forward(request, path);
}
