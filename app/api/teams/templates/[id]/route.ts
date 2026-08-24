import { NextResponse } from "next/server";
import type { UserTemplate } from "@/lib/team/templates";
import { getUserTemplates, writeUserTemplates } from "@/lib/team/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// PATCH /api/teams/templates/:id — 更新用户模板（仅用户模板；内置模板只读）
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const items = getUserTemplates<UserTemplate>();
    const idx = items.findIndex((t) => t.id === id);
    if (idx === -1) return NextResponse.json({ error: "Template not found" }, { status: 404 });
    const patch = (await req.json()) as Partial<UserTemplate>;
    items[idx] = { ...items[idx], ...patch, id, updatedAt: Date.now() };
    writeUserTemplates(items);
    return NextResponse.json({ template: items[idx] });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/teams/templates/:id — 删除用户模板
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const items = getUserTemplates<UserTemplate>();
    const next = items.filter((t) => t.id !== id);
    if (next.length === items.length) return NextResponse.json({ error: "Template not found" }, { status: 404 });
    writeUserTemplates(next);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
