// 路径式代理 URL 的兜底路由：/api/browser/proxy/<b64(base)>/<relpath>
//
// Next.js App Router 里 app/api/browser/proxy/route.ts 只匹配精确路径
// /api/browser/proxy，带 <b64>/<rel> 段的 URL 必须由 catch-all 接住，
// 否则会落到 Next 的默认 404。两个 handler 用同一份实现（父级 route.ts），
// parseProxyTarget 从完整 URL（request.nextUrl.href）解析目标，行为一致。
export { GET, POST } from "../route";
