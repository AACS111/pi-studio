import { NextResponse } from "next/server";
import { readUserLibrary, writeUserLibrary } from "@/lib/team/store";
import { BUILTIN_AGENTS, isBuiltinAgentId } from "@/lib/team/library";
import type { AgentLibraryItem } from "@/lib/team/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// PATCH /api/teams/agents/library/:id — 更新角色（含内置角色覆盖）
// - 用户自建角色：直接更新
// - 内置角色：第一次编辑时以内置内容为底创建覆盖项写入用户库（builtin: true），
//   后续编辑直接更新覆盖项；mergeLibrary 时用户覆盖优先于内置默认值。
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const items = readUserLibrary();
    const patch = (await req.json()) as Partial<AgentLibraryItem>;
    const idx = items.findIndex((i) => i.id === id);
    const now = Date.now();

    if (idx !== -1) {
      // 更新已有项（用户自建 或 已存在的内置覆盖）
      items[idx] = { ...items[idx], ...patch, id, updatedAt: now };
      writeUserLibrary(items);
      return NextResponse.json({ item: items[idx] });
    }

    // 内置角色第一次编辑 → 创建覆盖项
    const builtin = BUILTIN_AGENTS.find((a) => a.id === id);
    if (!builtin) {
      return NextResponse.json({ error: "Library item not found" }, { status: 404 });
    }
    const override: AgentLibraryItem = {
      ...builtin,
      ...patch,
      id,
      builtin: true,
      createdAt: now,
      updatedAt: now,
    };
    writeUserLibrary([...items, override]);
    return NextResponse.json({ item: override });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/teams/agents/library/:id — 删除用户角色；内置角色 = 恢复默认（移除覆盖项）
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const items = readUserLibrary();
    const next = items.filter((i) => i.id !== id);
    if (next.length === items.length && !isBuiltinAgentId(id)) {
      return NextResponse.json({ error: "Library item not found" }, { status: 404 });
    }
    writeUserLibrary(next);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
