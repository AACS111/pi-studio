import { NextResponse } from "next/server";
import { readUserLibrary, writeUserLibrary } from "@/lib/team/store";
import { mergeLibrary, overriddenBuiltinIds } from "@/lib/team/library";
import { randomUUID } from "crypto";
import type { AgentLibraryItem } from "@/lib/team/types";

export const dynamic = "force-dynamic";

// GET /api/teams/agents/library — 角色库（内置 + 用户）
// 返回 items（用户覆盖优先）+ overriddenIds（被覆盖的内置角色 id）
export async function GET() {
  try {
    const userItems = readUserLibrary();
    const items = mergeLibrary(userItems);
    const overriddenIds = [...overriddenBuiltinIds(userItems)];
    return NextResponse.json({ items, overriddenIds });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/teams/agents/library — 自建角色
// body: { id?, name, role, systemPrompt, toolNames?, emoji?, model? }  id 可选（缺省自动生成）
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<AgentLibraryItem> & { name?: string; role?: string; systemPrompt?: string };
    if (!body.name?.trim() || !body.role?.trim() || !body.systemPrompt?.trim()) {
      return NextResponse.json({ error: "name/role/systemPrompt are required" }, { status: 400 });
    }
    const now = Date.now();
    const item: AgentLibraryItem = {
      id: body.id?.trim() || `user-${randomUUID().slice(0, 8)}`,
      name: body.name.trim(),
      emoji: body.emoji,
      role: body.role.trim(),
      model: body.model ?? "",
      systemPrompt: body.systemPrompt.trim(),
      toolNames: Array.isArray(body.toolNames) ? body.toolNames : ["read", "bash", "edit", "write", "grep", "find", "ls"],
      skillIds: Array.isArray(body.skillIds) ? body.skillIds : undefined,
      createdAt: now,
      updatedAt: now,
    };
    const items = readUserLibrary();
    if (items.some((i) => i.id === item.id)) {
      return NextResponse.json({ error: `Library item id already exists: ${item.id}` }, { status: 409 });
    }
    writeUserLibrary([...items, item]);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
