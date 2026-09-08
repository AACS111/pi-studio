import { NextResponse } from "next/server";
import {
  listRegisteredProjects,
  registerProject,
  unregisterProject,
} from "@/lib/registered-projects";

// 「添加项目」持久登记表（见 lib/registered-projects.ts 头注释）：
// 侧栏项目列表 = 会话派生 ∪ 本登记表，实现「添加即显示、重启仍在」。

// GET /api/projects/registered → { projects: string[] }（新添加的在前）
export async function GET() {
  try {
    return NextResponse.json({ projects: listRegisteredProjects() });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function isClientError(error: unknown): boolean {
  const msg = String(error);
  return msg.includes("Directory does not exist") || msg.includes("Path is not a directory");
}

// POST /api/projects/registered  body: { cwd: string } → { ok: true, projects }
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const projects = registerProject(cwd);
    return NextResponse.json({ ok: true, projects });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: isClientError(error) ? 400 : 500 });
  }
}

// DELETE /api/projects/registered  body: { cwd: string } → { ok: true, projects }（幂等）
export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const projects = unregisterProject(cwd);
    return NextResponse.json({ ok: true, projects });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
