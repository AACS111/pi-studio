import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessionIds, getPendingSessionInfos } from "@/lib/rpc-manager";
import { resolveProject } from "@/lib/worktree";
import { listRegisteredProjects } from "@/lib/registered-projects";

export async function GET() {
  try {
    const sessions = await listAllSessions();
    // pi 延迟写盘：新会话要等首条 assistant 消息才创建 .jsonl，目录扫描看不到。
    // 把内存中尚未落盘的活跃会话合并进列表（按 id 去重），侧栏才能在
    // 「新会话发首条消息」后立即出现该条目，而不是等 30s 缓存过期。
    const scannedIds = new Set(sessions.map((s) => s.id));
    const pending = getPendingSessionInfos().filter((p) => !scannedIds.has(p.id));
    await Promise.all(pending.map(async (p) => {
      try {
        const project = await resolveProject(p.cwd);
        if (project?.projectRoot) p.projectRoot = project.projectRoot;
      } catch {
        // keep cwd as projectRoot fallback
      }
    }));
    return NextResponse.json({
      sessions: [...pending, ...sessions],
      runningSessionIds: getRunningRpcSessionIds(),
      // 「添加项目」持久登记的目录（可能还没有任何会话），侧栏取并集实现「添加即显示」
      registeredProjects: listRegisteredProjects(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
