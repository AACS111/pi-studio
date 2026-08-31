import { NextResponse } from "next/server";
import { existsSync, unlinkSync } from "fs";
import {
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
} from "@/lib/session-reader";
import { getPendingSessionInfos, getRpcSession } from "@/lib/rpc-manager";

// POST /api/projects/delete  body: { projectRoot: string }
// 删除项目时按需清除其全部会话数据：停掉活跃 RPC 会话、删除 .jsonl 文件并失效缓存。
// 只处理 projectRoot 匹配的会话；未勾选「清除数据」时前端不会调用本路由（仅本地隐藏）。
export async function POST(req: Request) {
  try {
    const body = await req.json() as { projectRoot?: string };
    const root = body.projectRoot?.trim();
    if (!root) {
      return NextResponse.json({ error: "projectRoot is required" }, { status: 400 });
    }

    // Windows 路径分隔符不统一（存储为 \，请求可能传 /），统一到 / 再比较
    const normalize = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
    const target = normalize(root);

    // 目录扫描 + 尚未落盘的活跃会话（pi 延迟写盘窗口内的新会话没有文件）
    const sessions = await listAllSessions();
    const scannedIds = new Set(sessions.map((s) => s.id));
    const pending = getPendingSessionInfos().filter((p) => !scannedIds.has(p.id));
    const targets = [...sessions, ...pending].filter(
      (s) => normalize(s.projectRoot ?? s.cwd) === target,
    );

    const deletedIds: string[] = [];
    for (const s of targets) {
      try {
        await getRpcSession(s.id)?.shutdown();
      } catch { /* session may already be gone */ }
      if (s.path && existsSync(s.path)) {
        try {
          unlinkSync(s.path);
        } catch { /* file locked / already removed */ }
      }
      invalidateSessionPathCache(s.id);
      deletedIds.push(s.id);
    }
    if (deletedIds.length > 0) invalidateSessionListCache();

    return NextResponse.json({ ok: true, deletedIds });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
