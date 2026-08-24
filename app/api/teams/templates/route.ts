import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { TEAM_TEMPLATES, type UserTemplate } from "@/lib/team/templates";
import { getUserTemplates, writeUserTemplates } from "@/lib/team/store";

export const dynamic = "force-dynamic";

// GET /api/teams/templates — 模板列表（内置 + 用户自定义，含可渲染预览）
export async function GET() {
  try {
    const builtin = TEAM_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      builtin: true,
      preview: t.build("preview", "/", t.name),
    }));
    const user = getUserTemplates<UserTemplate>().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description ?? "",
      builtin: false,
      preview: t,
    }));
    return NextResponse.json({ templates: [...user, ...builtin] });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/teams/templates — 新建用户模板
// body: { name, description?, agents, transitions, entryAgentId, reworkEdges?, ... }
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<UserTemplate> & { name?: string };
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!Array.isArray(body.agents) || !Array.isArray(body.transitions)) {
      return NextResponse.json({ error: "agents/transitions are required" }, { status: 400 });
    }
    const now = Date.now();
    const tpl: UserTemplate = {
      id: `tpl-${randomUUID().slice(0, 8)}`,
      name: body.name.trim(),
      description: body.description?.trim() || "",
      agents: body.agents,
      transitions: body.transitions,
      entryAgentId: body.entryAgentId ?? "",
      gateways: body.gateways,
      nodePositions: body.nodePositions,
      reworkEdges: body.reworkEdges,
      defaultRoutingMode: body.defaultRoutingMode ?? "hybrid",
      maxHops: body.maxHops ?? 30,
      maxReworkRounds: body.maxReworkRounds ?? 3,
      maxRunMinutes: body.maxRunMinutes ?? 30,
      contextScope: body.contextScope ?? "structured",
      createdAt: now,
      updatedAt: now,
    };
    writeUserTemplates([...getUserTemplates<UserTemplate>(), tpl]);
    return NextResponse.json({ template: tpl }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
