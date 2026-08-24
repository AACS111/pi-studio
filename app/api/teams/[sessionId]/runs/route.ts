import { NextResponse } from "next/server";
import { TeamStore } from "@/lib/team/store";
import { startTeamRun } from "@/lib/team/registry";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sessionId: string }> };

// POST /api/teams/:sessionId/runs — 发布任务并启动执行
// body: { task: string, agentId?: string }  agentId=起始角色（手动指派到特定角色）
export async function POST(req: Request, { params }: Params) {
  const { sessionId } = await params;
  try {
    const team = TeamStore.read(sessionId);
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    const body = (await req.json()) as { task?: string; agentId?: string };
    if (!body.task?.trim()) {
      return NextResponse.json({ error: "task is required" }, { status: 400 });
    }
    const agentId = body.agentId && team.agents.some((a) => a.id === body.agentId) ? body.agentId : undefined;
    const { runId } = startTeamRun(team, body.task.trim(), agentId);
    return NextResponse.json({ runId }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// GET /api/teams/:sessionId/runs — 运行历史
export async function GET(_req: Request, { params }: Params) {
  const { sessionId } = await params;
  try {
    if (!TeamStore.read(sessionId)) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    const runIds = TeamStore.listRunIds(sessionId);
    const runs = runIds
      .map((runId) => TeamStore.readRunMeta(sessionId, runId))
      .filter(Boolean)
      .sort((a, b) => (b?.createdAt ?? 0) - (a?.createdAt ?? 0));
    return NextResponse.json({ runs });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
