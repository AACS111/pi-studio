import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { validateAgentImages } from "@/lib/image-attachments";

export const dynamic = "force-dynamic";

const VISION_TIMEOUT_MS = 90_000;
const VISION_MAX_TOKENS = 2048;

interface VisionModelConfig {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * Find the first vision-capable model across custom providers in models.json.
 * A model counts as vision-capable when its `input` array includes "image"
 * and its provider has a baseUrl + apiKey.
 */
function findVisionModel(): VisionModelConfig | null {
  const path = join(getAgentDir(), "models.json");
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const providers = (raw as { providers?: Record<string, unknown> }).providers;
  if (!providers) return null;

  for (const [providerId, entry] of Object.entries(providers)) {
    if (!entry || typeof entry !== "object") continue;
    const provider = entry as {
      baseUrl?: unknown;
      apiKey?: unknown;
      name?: unknown;
      models?: unknown;
    };
    if (typeof provider.baseUrl !== "string" || !provider.baseUrl.trim()) continue;
    if (typeof provider.apiKey !== "string" || !provider.apiKey.trim()) continue;
    if (!Array.isArray(provider.models)) continue;

    for (const modelEntry of provider.models) {
      if (!modelEntry || typeof modelEntry !== "object") continue;
      const model = modelEntry as { id?: unknown; name?: unknown; input?: unknown };
      if (typeof model.id !== "string" || !model.id.trim()) continue;
      const input = Array.isArray(model.input)
        ? model.input.filter((x): x is string => typeof x === "string")
        : [];
      if (!input.includes("image")) continue;
      return {
        providerId,
        providerName: typeof provider.name === "string" && provider.name ? provider.name : providerId,
        modelId: model.id,
        modelName: typeof model.name === "string" && model.name ? model.name : model.id,
        baseUrl: provider.baseUrl.replace(/\/+$/, ""),
        apiKey: provider.apiKey,
      };
    }
  }
  return null;
}

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
  const { text, images } = body as { text?: unknown; images?: unknown };

  const imageError = validateAgentImages(images);
  if (imageError) return NextResponse.json({ error: imageError }, { status: 400 });
  const imageList = images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
  if (!imageList || imageList.length === 0) {
    return NextResponse.json({ error: "没有收到图片" }, { status: 400 });
  }

  const vision = findVisionModel();
  if (!vision) {
    return NextResponse.json(
      { error: "未配置支持图片输入的视觉模型：请在 models.json 中添加 input 包含 image 的模型（并配置 baseUrl 和 apiKey）" },
      { status: 400 },
    );
  }

  const promptText = typeof text === "string" && text.trim() ? text.trim() : "请描述图片内容。";
  const content: unknown[] = [{ type: "text", text: promptText }];
  for (const img of imageList) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.data}` },
    });
  }

  const endpoint = `${vision.baseUrl}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${vision.apiKey}`,
      },
      body: JSON.stringify({
        model: vision.modelId,
        messages: [{ role: "user", content }],
        max_tokens: VISION_MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
  } catch (e) {
    const message = e instanceof Error && e.name === "TimeoutError"
      ? "视觉模型识别超时"
      : "无法连接到视觉模型服务";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return NextResponse.json(
      { error: `视觉模型请求失败 (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}` },
      { status: 502 },
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return NextResponse.json({ error: "视觉模型返回了无效响应" }, { status: 502 });
  }
  const choices = (data as { choices?: unknown } | null)?.choices;
  const description = Array.isArray(choices) && choices.length > 0
    ? (choices[0] as { message?: { content?: unknown } })?.message?.content
    : undefined;
  if (typeof description !== "string" || !description.trim()) {
    return NextResponse.json({ error: "视觉模型没有返回识别结果" }, { status: 502 });
  }

  return NextResponse.json({
    description: description.trim(),
    modelId: vision.modelId,
    modelName: vision.modelName,
    providerId: vision.providerId,
  });
}
