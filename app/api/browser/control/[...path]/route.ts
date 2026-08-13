import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getInternalDir } from "@/lib/storage-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BRIDGE_TIMEOUT_MS = 300000; // /agent 任务可能跑几分钟

type RouteContext = { params: Promise<{ path: string[] }> };

/**
 * 右侧浏览器控制桥（Electron 原生 WebContentsView）的同源代理。
 *
 * 右侧浏览器只在 Electron 桌面模式（npm run dev:electron / 打包应用）可用：
 * Electron 主进程启动 bridge.cjs（127.0.0.1 随机端口）并把地址写入数据目录
 * 的 `pi-web-browser-bridge.json`（也通过 PI_WEB_BROWSER_BRIDGE_URL env 传给
 * Next 服务）。npm run dev 纯浏览器模式没有桥，语义接口（snapshot/execute/
 * select/fill/check/wait/assert）全部不可用。
 *
 * GET  /api/browser/control/snapshot|content|screenshot|url|health?…
 * POST /api/browser/control/execute|open|click|type|fill|select|check|press|scroll|wait|assert|back|forward|reload|input|close
 */
async function forward(request: NextRequest, pathSegments: string[]) {
  if (pathSegments.length === 0) {
    return NextResponse.json({ error: "missing browser control path" }, { status: 400 });
  }
  const path = pathSegments.join("/");

  const method = request.method;
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  const base = getBridgeBaseUrl();
  if (!base) {
    return NextResponse.json(
      {
        error: "右侧浏览器不可用：仅 Electron 桌面版（npm run dev:electron / 打包应用）支持浏览器控制，npm run dev 纯浏览器模式不支持。",
        detail: "browser control bridge not found — run npm run dev:electron or the packaged app",
      },
      { status: 502 },
    );
  }

  const url = new URL(`/${path}`, base);
  url.search = request.nextUrl.search;
  try {
    const upstream = await fetch(url, {
      method,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
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
    const detail =
      error instanceof DOMException && error.name === "TimeoutError"
        ? "browser control bridge timed out"
        : "browser control bridge unreachable — restart the Electron app";
    return NextResponse.json({ error: detail }, { status: 502 });
  }
}

function getBridgeBaseUrl(): string | null {
  // 1. env（Electron 主进程传给 Next 服务）
  const fromEnv = process.env.PI_WEB_BROWSER_BRIDGE_URL?.trim();
  if (fromEnv) {
    try {
      const u = new URL(fromEnv);
      if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) {
        return u.href.replace(/\/+$/, "");
      }
    } catch {
      /* fallthrough */
    }
  }
  // 2. 桥标记文件（Electron 主进程启动 bridge 时写入数据目录）
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

export async function GET(request: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  return forward(request, path);
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const { path } = await ctx.params;
  return forward(request, path);
}
