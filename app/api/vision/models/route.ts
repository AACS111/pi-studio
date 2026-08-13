import { NextResponse } from "next/server";
import {
  getVisionModelSelection,
  listVisionModels,
  setVisionModelSelection,
  type VisionModelSelection,
} from "@/lib/vision-model";

export const dynamic = "force-dynamic";

/** GET /api/vision/models — 可选的视觉代理（附属模型）列表与当前选择。 */
export async function GET() {
  return NextResponse.json({
    models: listVisionModels(),
    selected: getVisionModelSelection(),
  });
}

/** POST /api/vision/models — 持久化附属模型选择；空 body 表示恢复自动选择。 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  const { provider, modelId } = body as { provider?: unknown; modelId?: unknown };
  let selection: VisionModelSelection | null = null;
  if (typeof provider === "string" && provider && typeof modelId === "string" && modelId) {
    selection = { provider, modelId };
  }
  // 校验：显式选择的模型必须存在于 models.json 且支持图片。
  if (
    selection
    && !listVisionModels().some(
      (m) => m.provider === selection?.provider && m.modelId === selection?.modelId,
    )
  ) {
    return NextResponse.json(
      { error: "所选模型不是已配置的支持图片输入的模型（models.json 中 input 需包含 image，并配置 baseUrl 和 apiKey）" },
      { status: 400 },
    );
  }
  setVisionModelSelection(selection);
  return NextResponse.json({
    models: listVisionModels(),
    selected: selection,
  });
}
