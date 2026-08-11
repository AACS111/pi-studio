import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getInternalDir } from "@/lib/storage-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_SIDECAR_BASE = "http://127.0.0.1:17865";
const SIDECAR_TIMEOUT_MS = 300000; // /agent 任务可能跑几分钟

type RouteContext = { params: Promise<{ path: string[] }> };

function getBridgeMarkerBaseUrl(): string | null {
  try {
    const markerPath = join(getInternalDir(), "pi-web-browser-bridge.json");
    if (!existsSync(markerPath)) return null;
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as { baseUrl?: unknown };
    if (typeof parsed.baseUrl !== "string") return null;
    const url = new URL(parsed.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function getSidecarBases(): string[] {
  const bases = [
    process.env.PI_BROWSER_USE_BASE_URL,
    getBridgeMarkerBaseUrl(),
    DEFAULT_SIDECAR_BASE,
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(bases.map((value) => value.replace(/\/+$/, ""))));
}

/**
 * pi-studio → 浏览器控制桥（Electron 原生 WebContentsView / browser-use 侧车）的同源代理。
 *
 * 浏览器页面无法直连桥（127.0.0.1，无 CORS），通过本路由同源转发，
 * 让右侧面板的「Agent 控制台」视图可以轮询截图/URL/内容。
 *
 * GET  /api/browser/control/snapshot|content|screenshot|url|health?…
 * POST /api/browser/control/execute|open|click|type|fill|select|check|press|scroll|wait|assert|back|forward|reload|input|close
 *
 * 语义接口（snapshot/execute/select/fill/check/wait/assert）由 Electron 原生桥提供
 * （见 electron/bridge.cjs Semantic Browser V2）；Web 模式下这些端点由侧车返回 404，
 * agent 回退到 content/click/type/press。
 */
async function forward(request: NextRequest, pathSegments: string[]) {
  if (pathSegments.length === 0) {
    return NextResponse.json({ error: "missing sidecar path" }, { status: 400 });
  }
  const path = pathSegments.join("/");

  const method = request.method;
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  let lastError: unknown = null;
  for (const base of getSidecarBases()) {
    const url = new URL(`/${path}`, base);
    url.search = request.nextUrl.search;
    try {
      const upstream = await fetch(url, {
        method,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
        headers: {
          accept: request.headers.get("accept") ?? "*/*",
          "content-type": request.headers.get("content-type") ?? "application/json",
        },
      });

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
    } catch (error) {
      lastError = error;
    }
  }

  const detail =
    lastError instanceof DOMException && lastError.name === "TimeoutError"
      ? "browser control bridge timed out"
      : "browser control bridge unreachable — run npm run dev:electron for the native right-panel browser";
  return NextResponse.json({ error: detail }, { status: 502 });
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  return forward(request, path);
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  return forward(request, path);
}
