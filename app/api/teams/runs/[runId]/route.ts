import { NextResponse } from "next/server";
import { readRunDetail } from "@/lib/team/registry";
import { TeamStore } from "@/lib/team/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ runId: string }> };

// GET /api/teams/runs/:runId — run 详情（run + 投影 + 事件）
export async function GET(_req: Request, { params }: Params) {
  const { runId } = await params;
  try {
    // 从 runId 无法直接知道 sessionId：扫描 registry 或团队目录
    const index = TeamStore.list();
    for (const sessionId of Object.keys(index)) {
      const runIds = TeamStore.listRunIds(sessionId);
      if (runIds.includes(runId)) {
        const detail = readRunDetail(sessionId, runId);
        return NextResponse.json({ sessionId, ...detail });
      }
    }
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
