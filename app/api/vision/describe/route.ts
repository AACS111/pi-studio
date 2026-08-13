import { NextResponse } from "next/server";
import { validateAgentImages } from "@/lib/image-attachments";
import {
  resolveVisionModel,
  type VisionModelInfo,
  type VisionModelSelection,
} from "@/lib/vision-model";

export const dynamic = "force-dynamic";

const VISION_TIMEOUT_MS = 90_000;
const VISION_MAX_TOKENS = 2048;
/**
 * ModelScope 等免费推理的首次请求常因模型冷启动返回 200 + 空 choices，
 * 稍等重试一次可显著提高成功率。
 */
const VISION_RETRY_DELAY_MS = 3_000;

type VisionResult =
  | { ok: true; description: string }
  | { ok: false; error: string };

/** 调用视觉模型；对空 choices / 5xx / 429 做一次延迟重试（冷启动兜底）。 */
async function callVisionModel(
  vision: VisionModelInfo,
  promptText: string,
  imageList: Array<{ type: "image"; data: string; mimeType: string }>,
): Promise<VisionResult> {
  const content: unknown[] = [{ type: "text", text: promptText }];
  for (const img of imageList) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.data}` },
    });
  }
  const endpoint = `${vision.baseUrl}/chat/completions`;
  const payload = JSON.stringify({
    model: vision.modelId,
    messages: [{ role: "user", content }],
    max_tokens: VISION_MAX_TOKENS,
    stream: false,
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${vision.apiKey}`,
  };

  let lastError = "视觉模型没有返回识别结果";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      });
    } catch (e) {
      lastError = e instanceof Error && e.name === "TimeoutError"
        ? "视觉模型识别超时"
        : "无法连接到视觉模型服务";
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, VISION_RETRY_DELAY_MS));
        continue;
      }
      return { ok: false, error: lastError };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      lastError = `视觉模型请求失败 (HTTP ${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`;
      // 429 / 5xx 可能是免费额度排队，等 3s 重试一次。
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, VISION_RETRY_DELAY_MS));
        continue;
      }
      return { ok: false, error: lastError };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { ok: false, error: "视觉模型返回了无效响应" };
    }
    const choices = (data as { choices?: unknown } | null)?.choices;
    const description = Array.isArray(choices) && choices.length > 0
      ? (choices[0] as { message?: { content?: unknown } })?.message?.content
      : undefined;
    if (typeof description === "string" && description.trim()) {
      return { ok: true, description: description.trim() };
    }
    // 200 但 choices 为空：多半是模型冷启动/排队中，稍等重试一次。
    lastError = "视觉模型没有返回识别结果";
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, VISION_RETRY_DELAY_MS));
    }
  }
  return { ok: false, error: lastError };
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
  const { text, images, model } = body as {
    text?: unknown;
    images?: unknown;
    model?: unknown;
  };

  const imageError = validateAgentImages(images);
  if (imageError) return NextResponse.json({ error: imageError }, { status: 400 });
  const imageList = images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
  if (!imageList || imageList.length === 0) {
    return NextResponse.json({ error: "没有收到图片" }, { status: 400 });
  }

  // 显式选择（客户端左下角「附属模型」）优先，其次持久化选择，最后自动扫描。
  let explicit: VisionModelSelection | null = null;
  if (model && typeof model === "object") {
    const candidate = model as Partial<VisionModelSelection>;
    if (
      typeof candidate.provider === "string" && candidate.provider
      && typeof candidate.modelId === "string" && candidate.modelId
    ) {
      explicit = { provider: candidate.provider, modelId: candidate.modelId };
    }
  }
  const { model: vision } = resolveVisionModel(explicit);
  if (!vision) {
    return NextResponse.json(
      { error: "未配置支持图片输入的视觉模型：请在左下角模型菜单的「附属模型」中选择视觉模型，或在 models.json 中添加 input 包含 image 的模型（并配置 baseUrl 和 apiKey）" },
      { status: 400 },
    );
  }

  const promptText = typeof text === "string" && text.trim() ? text.trim() : "请描述图片内容。";
  const result = await callVisionModel(vision, promptText, imageList);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  return NextResponse.json({
    description: result.description,
    modelId: vision.modelId,
    modelName: vision.modelName,
    providerId: vision.provider,
  });
}
