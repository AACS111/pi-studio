import { NextResponse } from "next/server";
import { TeamStore } from "@/lib/team/store";
import { validateWorkflow } from "@/lib/team/validate";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sessionId: string }> };

// POST /api/teams/:sessionId/validate — Workflow 静态校验（保存前调用）
export async function POST(_req: Request, { params }: Params) {
  const { sessionId } = await params;
  try {
    const team = TeamStore.read(sessionId);
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    const validation = validateWorkflow(team);
    return NextResponse.json({ validation });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
