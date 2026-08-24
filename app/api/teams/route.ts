import { NextResponse } from "next/server";
import { createTeam } from "@/lib/team/lifecycle";
import { TeamStore } from "@/lib/team/store";

export const dynamic = "force-dynamic";

// GET /api/teams — 项目组列表（含 uiMode）
export async function GET() {
  try {
    const index = TeamStore.list();
    const teams = Object.entries(index)
      .filter(([, entry]) => entry.uiMode === "team")
      .map(([sessionId, entry]) => {
        const team = TeamStore.read(sessionId);
        return {
          sessionId,
          name: team?.name ?? entry.name,
          agentCount: team?.agents.length ?? 0,
          entryAgentId: team?.entryAgentId ?? "",
          uiMode: entry.uiMode,
          createdAt: entry.createdAt,
        };
      });
    return NextResponse.json({ teams });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/teams — 新建项目组（创建即会话）
// body: { cwd, name?, templateId?, agentIds?: string[] }
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { cwd?: string; name?: string; templateId?: string; agentIds?: string[] };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const result = createTeam({ cwd: body.cwd, name: body.name, templateId: body.templateId, agentIds: body.agentIds });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
