import { getTerminalManager } from "@/lib/terminal-manager";
import type { TerminalEvent } from "@/lib/terminal-session";

export const dynamic = "force-dynamic";

// GET /api/terminal/[id]/events — SSE stream of PTY output + status.
// On connect the recent output ring buffer is replayed first, then live data
// streams. The client resets its xterm before replay, so a page reload or a
// dropped stream re-syncs cleanly without duplication.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = getTerminalManager().get(id);
  if (!session) {
    return new Response("Terminal not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: TerminalEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      // Replay recent output for late joiners (page reload / reconnect).
      const buffered = session.getBufferedOutput();
      if (buffered) send({ type: "data", data: buffered });
      send({ type: "status", status: session.getStatus(), exitCode: session.getExitCode() });

      const unsubscribe = session.subscribe((event) => send(event));

      // Heartbeat every 30s to prevent server/proxy timeouts.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
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
    },
  });
}
