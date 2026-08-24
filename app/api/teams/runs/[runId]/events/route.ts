import { TeamStore } from "@/lib/team/store";
import { subscribeTeamRun } from "@/lib/team/registry";
import type { TeamEvent, TeamRun } from "@/lib/team/types";

export const dynamic = "force-dynamic";

// GET /api/teams/runs/:runId/events — SSE 事件流
// 客户端带 Last-Event-ID（= sequence）重连：先 replay > Last-Event-ID，再实时增量。
// 每个事件发送两份：`event: <type>` + `data: {sequence, ...}`。
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;

  // 定位 sessionId
  const index = TeamStore.list();
  let sessionId: string | undefined;
  for (const sid of Object.keys(index)) {
    if (TeamStore.listRunIds(sid).includes(runId)) {
      sessionId = sid;
      break;
    }
  }
  if (!sessionId) {
    return new Response("Run not found", { status: 404 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: TeamEvent) => {
        try {
          const type = event.type;
          controller.enqueue(encoder.encode(`event: ${type}\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* controller closed */
        }
      };
      const sendRun = (run: TeamRun) => {
        try {
          controller.enqueue(encoder.encode(`event: run_update\ndata: ${JSON.stringify(run)}\n\n`));
        } catch {
          /* controller closed */
        }
      };

      // Last-Event-ID 重连：只补增量
      const lastEventIdHeader = req.headers.get("last-event-id");
      const lastSequence = lastEventIdHeader ? Number(lastEventIdHeader) : 0;

      const unsubscribe = subscribeTeamRun(runId, (event) => {
        if (event.sequence > lastSequence) send(event);
      }, sendRun);

      // 心跳保活
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          /* controller closed */
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
