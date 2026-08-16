import { NextResponse } from "next/server";
import { getTerminalManager } from "@/lib/terminal-manager";

export const dynamic = "force-dynamic";

const MAX_INPUT_BYTES = 256 * 1024;

// GET /api/terminal/[id] — status snapshot
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = getTerminalManager().get(id);
  if (!session) return NextResponse.json({ error: "Terminal not found" }, { status: 404 });
  return NextResponse.json({
    id: session.id,
    shell: session.shell.id,
    shellLabel: session.shell.label,
    cwd: session.cwd,
    status: session.getStatus(),
    exitCode: session.getExitCode(),
    cols: session.getCols(),
    rows: session.getRows(),
  });
}

// POST /api/terminal/[id] — write input and/or resize the PTY
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const manager = getTerminalManager();

  let resized = true;
  const resize = body.resize as { cols?: unknown; rows?: unknown } | undefined;
  if (resize && typeof resize.cols === "number" && typeof resize.rows === "number") {
    resized = manager.resize(id, resize.cols, resize.rows);
  }

  const data = typeof body.data === "string" ? body.data : "";
  if (data) {
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) {
      return NextResponse.json({ error: "Input too large" }, { status: 413 });
    }
    const wrote = manager.write(id, data);
    if (!wrote) return NextResponse.json({ error: "Terminal has exited" }, { status: 409 });
  }

  if (!resized && !data) {
    return NextResponse.json({ error: "Terminal has exited" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}

// DELETE /api/terminal/[id] — kill and forget the terminal
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = getTerminalManager().kill(id);
  return NextResponse.json({ ok });
}
