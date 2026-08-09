import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidBasicAuthorization,
  isWebPasswordEnabled,
} from "@/lib/web-auth";

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  // 右侧面板的网页代理：沙箱 iframe（无 allow-same-origin）加载它的子资源时
  // 请求是跨站的（Origin: null / Sec-Fetch-Site: cross-site），会被下面的 CSRF
  // 校验拦截。它是纯内容代理（只抓取公开网页），设计上就要被跨源调用，
  // 因此只校验 Host（必须在允许的主机上），跳过 Origin 校验。
  const isBrowserContentProxy = request.nextUrl.pathname.startsWith("/api/browser/proxy");
  const isTrustedRequest = isApiRequest
    ? (isBrowserContentProxy
        ? isApiRequestHostAllowed(request)
        : isApiRequestAllowed(request))
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (
    isWebPasswordEnabled(password)
    && !isValidBasicAuthorization(request.headers.get("authorization"), password)
  ) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Studio", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/api/:path*"] };
