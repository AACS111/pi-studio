import { NextResponse } from "next/server";
import { steerTeamRun } from "@/lib/team/registry";

export const dynamic = "force-dynamic";

// POST /api/teams/runs/:runId/steer — 人工介入（@角色 消息）
// body: { content: string, agentId? }
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const body = (await req.json()) as { content?: string; agentId?: string };
    if (!body.content?.trim()) {
      return NextResponse.json({ error: "content is required" }, { status: 400 });
    }
    const ok = steerTeamRun(runId, body.content.trim(), body.agentId);
    if (!ok) return NextResponse.json({ error: "Run not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
