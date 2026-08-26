import { NextResponse } from "next/server";
import { rejectTeamRun } from "@/lib/team/registry";

export const dynamic = "force-dynamic";

// POST /api/teams/runs/:runId/reject — 驳回当前等待审批的 transition（P1-2 人工审批闸门）
export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const ok = rejectTeamRun(runId);
    if (!ok) return NextResponse.json({ error: "Run not found or not awaiting approval" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
