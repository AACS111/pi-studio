import { NextResponse } from "next/server";
import { getSessionEntries, resolveSessionPath } from "@/lib/session-reader";
import type { ImageContent } from "@/lib/types";

/**
 * GET /api/sessions/[id]/media?ref=<entryId>:<blockIndex>
 *
 * 历史会话里的图片不再内联 base64（`deferMedia=1` 时后端把用户/助手侧图片换成
 * mediaRef 桩），前端 `<img loading="lazy">` 滚到可见才来拉这一张。
 * 会话条目不可变，故可长缓存。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ref = new URL(req.url).searchParams.get("ref") ?? "";
  const separator = ref.lastIndexOf(":");
  const entryId = separator > 0 ? ref.slice(0, separator) : "";
  const blockIndex = Number(separator > 0 ? ref.slice(separator + 1) : NaN);
  if (!entryId || !Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    return NextResponse.json({ error: "Valid ref is required" }, { status: 400 });
  }

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    // SessionManager-backed parsing preserves the SDK's malformed-line tolerance.
    const entry = getSessionEntries(filePath).find((candidate) => candidate.id === entryId);
    if (!entry || entry.type !== "message") {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }
    const message = entry.message as unknown as { content?: unknown };
    const content = Array.isArray(message.content) ? message.content : null;
    const block = (content?.[blockIndex] ?? null) as ImageContent | null;
    if (!block || block.type !== "image") {
      return NextResponse.json({ error: "Image block not found" }, { status: 404 });
    }

    let data = typeof block.data === "string" ? block.data : "";
    let mime = typeof block.mimeType === "string" ? block.mimeType : "image/png";
    if (!data && block.source?.type === "base64" && typeof block.source.data === "string") {
      data = block.source.data;
      if (typeof block.source.media_type === "string") mime = block.source.media_type;
    }
    if (!data) return NextResponse.json({ error: "Image data not found" }, { status: 404 });

    return new NextResponse(Buffer.from(data, "base64"), {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
