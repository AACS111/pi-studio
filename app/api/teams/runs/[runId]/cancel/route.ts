import { NextResponse } from "next/server";
import { cancelTeamRun } from "@/lib/team/registry";

export const dynamic = "force-dynamic";

// POST /api/teams/runs/:runId/cancel — 取消运行
export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const ok = cancelTeamRun(runId);
    if (!ok) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
