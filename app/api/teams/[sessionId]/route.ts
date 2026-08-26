import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { TeamStore } from "@/lib/team/store";
import { setTeamUiMode, deleteTeam } from "@/lib/team/lifecycle";
import { validateWorkflow } from "@/lib/team/validate";
import { readTeamChat } from "@/lib/team/lifecycle";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { resolveSessionPath } from "@/lib/session-reader";
import type { TeamDef } from "@/lib/team/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sessionId: string }> };

// GET /api/teams/:sessionId — 详情（配置 + 群聊 + 校验结果）
export async function GET(_req: Request, { params }: Params) {
  const { sessionId } = await params;
  try {
    const team = TeamStore.read(sessionId);
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    const validation = validateWorkflow(team);
    return NextResponse.json({
      team,
      validation,
      chat: readTeamChat(sessionId),
      runIds: TeamStore.listRunIds(sessionId),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/teams/:sessionId — 更新配置（agents/transitions/limits/routingMode/name/uiMode）
// body: { name?, agents?, transitions?, reworkEdges?, defaultRoutingMode?,
//         maxHops?, maxReworkRounds?, maxRunMinutes?, contextScope?, uiMode? }
export async function PATCH(req: Request, { params }: Params) {
  const { sessionId } = await params;
  try {
    const team = TeamStore.read(sessionId);
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    const body = (await req.json()) as Record<string, unknown>;

    if (body.uiMode === "chat" || body.uiMode === "team") {
      setTeamUiMode(sessionId, body.uiMode);
      return NextResponse.json({ ok: true, uiMode: body.uiMode });
    }

    const next: TeamDef = {
      ...team,
      name: typeof body.name === "string" ? body.name : team.name,
      agents: Array.isArray(body.agents) ? (body.agents as TeamDef["agents"]) : team.agents,
      transitions: Array.isArray(body.transitions) ? (body.transitions as TeamDef["transitions"]) : team.transitions,
      gateways: Array.isArray(body.gateways) ? (body.gateways as TeamDef["gateways"]) : team.gateways,
      nodePositions: body.nodePositions !== undefined ? (body.nodePositions as TeamDef["nodePositions"]) : team.nodePositions,
      reworkEdges: body.reworkEdges !== undefined ? (body.reworkEdges as TeamDef["reworkEdges"]) : team.reworkEdges,
      defaultRoutingMode: typeof body.defaultRoutingMode === "string" ? (body.defaultRoutingMode as TeamDef["defaultRoutingMode"]) : team.defaultRoutingMode,
      maxHops: typeof body.maxHops === "number" ? body.maxHops : team.maxHops,
      maxReworkRounds: typeof body.maxReworkRounds === "number" ? body.maxReworkRounds : team.maxReworkRounds,
      maxRunMinutes: typeof body.maxRunMinutes === "number" ? body.maxRunMinutes : team.maxRunMinutes,
      contextScope: typeof body.contextScope === "string" ? (body.contextScope as TeamDef["contextScope"]) : team.contextScope,
      executionMode: typeof body.executionMode === "string" ? (body.executionMode as TeamDef["executionMode"]) : team.executionMode,
      entryAgentId: typeof body.entryAgentId === "string" && body.entryAgentId ? (body.entryAgentId as TeamDef["entryAgentId"]) : team.entryAgentId,
      updatedAt: Date.now(),
    };
    // 空 entryAgentId 自动修复：有角色但没入口 → 取第一个角色
    if (!next.entryAgentId && next.agents.length > 0) {
      next.entryAgentId = next.agents[0].id;
    }
    TeamStore.write(next);
    // 同步 index.json 的 name（sidebar/顶部标题用 teamName 展示）
    TeamStore.upsertIndex(sessionId, { name: next.name });
    // 同步宿主 pi 会话的 name（侧边栏列表标题用 session.name，改此处才能跟随）
    try {
      const filePath = await resolveSessionPath(sessionId);
      if (filePath) {
        const sm = SessionManager.open(filePath);
        sm.appendSessionInfo(next.name);
      }
    } catch {
      /* pi 会话名同步失败不阻断 */
    }
    invalidateSessionListCache();
    return NextResponse.json({ ok: true, team: next });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/teams/:sessionId — 删除项目组（连同宿主会话）
export async function DELETE(_req: Request, { params }: Params) {
  const { sessionId } = await params;
  try {
    await deleteTeam(sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
