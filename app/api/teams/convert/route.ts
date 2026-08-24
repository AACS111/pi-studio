import { NextResponse } from "next/server";
import { convertTeam } from "@/lib/team/lifecycle";

export const dynamic = "force-dynamic";

// POST /api/teams/convert — 已有会话转项目组（历史导入）
// body: { sessionId, name?, templateId?, agentIds?: string[] }
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { sessionId?: string; name?: string; templateId?: string; agentIds?: string[] };
    if (!body.sessionId || typeof body.sessionId !== "string") {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }
    const result = await convertTeam({ sessionId: body.sessionId, name: body.name, templateId: body.templateId, agentIds: body.agentIds });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /already a team|not found/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
