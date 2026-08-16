import { NextResponse } from "next/server";
import { getDshUiSnapshot, startDshUi, stopDshUi, installUiPlugin } from "@/lib/dsh-ui-runtime";

export const dynamic = "force-dynamic";

// GET /api/dsh/ui — DSH Web UI 运行时快照 + 启动日志尾。
export async function GET() {
  return NextResponse.json(getDshUiSnapshot());
}

// POST /api/dsh/ui — { action: "start" | "stop" | "install", package? }
export async function POST(req: Request) {
  let body: { action?: string; package?: string };
  try {
    body = (await req.json()) as { action?: string; package?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const action = body.action ?? "start";

  if (action === "stop") {
    return NextResponse.json(stopDshUi());
  }
  if (action === "install") {
    const pkg = (body.package ?? "").trim();
    if (!pkg) return NextResponse.json({ error: "package required" }, { status: 400 });
    const result = await installUiPlugin(pkg);
    if (!result.ok) {
      return NextResponse.json({ error: result.output }, { status: 500 });
    }
    // 安装后启动运行时，返回 url 供前端打开右面板。
    const snapshot = await startDshUi();
    return NextResponse.json({ success: true, ...snapshot, output: result.output });
  }
  // start
  return NextResponse.json(await startDshUi());
}
