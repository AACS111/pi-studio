import { NextResponse } from "next/server";
import { detectDshPackage } from "@/lib/plugins/adapters/dsh/dsh-detect";

export const dynamic = "force-dynamic";

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; result: unknown }>();

// POST /api/dsh/detect  body: { package: "npm-package" }
// 安装前的适配检测：返回 DSH → Pi 的 seam 映射、分数与可安装判定。
export async function POST(req: Request) {
  let body: { package?: string };
  try {
    body = (await req.json()) as { package?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const pkg = (body.package ?? "").trim();
  if (!pkg) return NextResponse.json({ error: "package required" }, { status: 400 });

  const cached = cache.get(pkg);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json(cached.result);
  }

  const result = await detectDshPackage(pkg);
  cache.set(pkg, { at: Date.now(), result });
  return NextResponse.json(result);
}
