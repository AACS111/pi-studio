import { NextResponse } from "next/server";
import { listUiExtensions, registerUiExtension, unregisterUiExtension } from "@/lib/plugins/ui/ui-registry";
import type { PiUiExtension } from "@/lib/plugins/ui/types";

export const dynamic = "force-dynamic";

// GET /api/plugins/ui — 已注册的 UI 扩展（ActivityBar rail + 面板渲染用）。
export async function GET() {
  return NextResponse.json({ extensions: listUiExtensions() });
}

// POST /api/plugins/ui — 注册一个 UI 扩展（供动态场景 / 插件加载时显式注册）。
export async function POST(req: Request) {
  let body: Partial<PiUiExtension>;
  try {
    body = (await req.json()) as Partial<PiUiExtension>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.id || !body.pluginId || !body.origin || !body.title) {
    return NextResponse.json({ error: "id / pluginId / origin / title required" }, { status: 400 });
  }
  registerUiExtension(body as PiUiExtension);
  return NextResponse.json({ success: true, extensions: listUiExtensions() });
}

// DELETE /api/plugins/ui?id=... — 移除一个 UI 扩展。
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  unregisterUiExtension(id);
  return NextResponse.json({ success: true, extensions: listUiExtensions() });
}
