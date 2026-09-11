import { NextRequest, NextResponse } from "next/server";
import { readContextDietSettings, writeContextDietSettings } from "@/lib/context-diet-settings";

/**
 * GET /api/settings/context-diet —— 读取上下文精简设置
 * PATCH —— 局部更新（只传要改的字段）
 *
 * 注意：补丁侧每 5s 重读 settings.json，所以改完 5s 内对后续请求生效，无需重启。
 */
export async function GET() {
  try {
    return NextResponse.json({ success: true, data: readContextDietSettings() });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const patch: { enabled?: boolean; keepRecentToolResults?: number; foldMinChars?: number; keepRecentImages?: number } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.keepRecentToolResults === "number") patch.keepRecentToolResults = body.keepRecentToolResults;
    if (typeof body.foldMinChars === "number") patch.foldMinChars = body.foldMinChars;
    if (typeof body.keepRecentImages === "number") patch.keepRecentImages = body.keepRecentImages;
    return NextResponse.json({ success: true, data: writeContextDietSettings(patch) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
