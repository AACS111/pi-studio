import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  clampTriggerRatio,
  COMPACTION_TRIGGER_RATIO_DEFAULT,
  readCompactionSettings,
  recommendedCompactionForWindow,
  writeCompactionSettings,
} from "@/lib/compaction-settings";

/**
 * 解析默认模型（settings.json 的 defaultProvider/defaultModel）的上下文窗口。
 * PATCH 只改比例时用它立即折算阈值，避免出现「比例=0.4、reserveTokens 还是旧值」的过期状态。
 * 取不到（模型是 pi 内置目录的、models.json 缺失等）就只存比例，由会话启动时重算。
 */
function resolveDefaultModelWindow(): number | undefined {
  try {
    const agentDir = getAgentDir();
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      defaultProvider?: unknown;
      defaultModel?: unknown;
    };
    const providerId = settings.defaultProvider;
    const modelId = settings.defaultModel;
    if (typeof providerId !== "string" || typeof modelId !== "string") return undefined;
    const modelsPath = join(agentDir, "models.json");
    if (!existsSync(modelsPath)) return undefined;
    const models = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      providers?: Record<string, { models?: Array<{ id?: string; contextWindow?: number }>; modelOverrides?: Record<string, { contextWindow?: number }> }>;
    };
    const provider = models.providers?.[providerId];
    const override = provider?.modelOverrides?.[modelId]?.contextWindow;
    const declared = provider?.models?.find((entry) => entry?.id === modelId)?.contextWindow;
    const window = typeof override === "number" ? override : declared;
    return typeof window === "number" && window > 0 ? window : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 全局上下文自动压缩设置（读写 ~/.pi/agent/settings.json 的 compaction 段）。
 *
 * GET   /api/settings/compaction                  → { enabled, reserveTokens, keepRecentTokens, triggerRatio? }
 * PATCH /api/settings/compaction { triggerRatio }  → 同上（triggerRatio 传 null 清除比例策略）
 *
 * triggerRatio = 自动压缩触发点占模型窗口的比例（0.1~0.95，默认 0.25）。
 * pi 的判定式是 contextTokens > contextWindow - reserveTokens，所以这里只存**比例**：
 * reserveTokens / keepRecentTokens 由 lib/rpc-manager.ts 在每次会话启动时按当前模型窗口重算
 * （1M 窗口的模型按固定 reserve 永远触发不到压缩，见 lib/compaction-settings.ts 顶部注释）。
 */
export async function GET() {
  try {
    return NextResponse.json(readCompactionSettings());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { triggerRatio?: unknown; enabled?: unknown }
      | null;
    if (!body || (body.triggerRatio === undefined && typeof body.enabled !== "boolean")) {
      return NextResponse.json({ error: "triggerRatio or enabled required" }, { status: 400 });
    }
    if (body.triggerRatio !== undefined && body.triggerRatio !== null) {
      if (typeof body.triggerRatio !== "number" || !Number.isFinite(body.triggerRatio)) {
        return NextResponse.json({ error: "triggerRatio must be a number" }, { status: 400 });
      }
      if (body.triggerRatio < 0.1 || body.triggerRatio > 0.95) {
        return NextResponse.json({ error: "triggerRatio must be between 0.1 and 0.95" }, { status: 400 });
      }
    }
    const next = writeCompactionSettings({
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(body.triggerRatio === undefined
        ? {}
        : { triggerRatio: body.triggerRatio === null ? null : clampTriggerRatio(body.triggerRatio) }),
    });
    // 比例变更时按默认模型窗口立即折算阈值（会话启动时会再按实际模型重算一次）
    if (body.triggerRatio !== undefined && body.triggerRatio !== null) {
      const window = resolveDefaultModelWindow();
      if (window !== undefined) {
        return NextResponse.json(
          writeCompactionSettings(
            recommendedCompactionForWindow(window, next.triggerRatio ?? COMPACTION_TRIGGER_RATIO_DEFAULT),
          ),
        );
      }
    }
    return NextResponse.json(next);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
