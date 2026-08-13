import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { getInternalDir } from "@/lib/storage-config";

/**
 * 视觉代理（附属模型）解析与持久化。
 *
 * 当主模型不支持图片输入时，pi-studio 会把图片交给「视觉模型」识别成文字，
 * 再把文字结果发给主模型。本模块负责：
 *  - 列出 models.json 里所有支持图片输入且已配置 baseUrl+apiKey 的模型；
 *  - 持久化用户在左下角模型下拉里选择的附属模型；
 *  - 解析实际使用的视觉模型（显式选择 > 持久化选择 > 自动扫描）。
 */

export interface VisionModelInfo {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  baseUrl: string;
  apiKey: string;
}

export interface VisionModelSelection {
  provider: string;
  modelId: string;
}

const VISION_SELECTION_FILE = "pi-web-vision-model.json";

interface ModelsJsonShape {
  providers?: Record<string, unknown>;
}

/** 读取 ~/.pi/agent/models.json（自定义提供商目录）。 */
function readModelsJson(): ModelsJsonShape {
  const path = join(getAgentDir(), "models.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ModelsJsonShape;
  } catch {
    return {};
  }
}

/**
 * 列出 models.json 里所有「支持图片输入（input 含 image）且已配置
 * baseUrl + apiKey」的模型。这些模型可被选为视觉代理（附属模型）。
 */
export function listVisionModels(): VisionModelInfo[] {
  const providers = readModelsJson().providers ?? {};
  const result: VisionModelInfo[] = [];
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
      result.push({
        provider: providerId,
        providerName: typeof provider.name === "string" && provider.name ? provider.name : providerId,
        modelId: model.id,
        modelName: typeof model.name === "string" && model.name ? model.name : model.id,
        baseUrl: provider.baseUrl.replace(/\/+$/, ""),
        apiKey: provider.apiKey,
      });
    }
  }
  return result;
}

/** 找到第一个满足条件的视觉模型（默认任意）。 */
export function findVisionModel(
  predicate?: (m: VisionModelInfo) => boolean,
): VisionModelInfo | null {
  return listVisionModels().find((m) => (predicate ? predicate(m) : true)) ?? null;
}

function selectionFilePath(): string {
  return join(getInternalDir(), VISION_SELECTION_FILE);
}

/** 读取持久化的视觉代理模型选择（null = 自动选择）。 */
export function getVisionModelSelection(): VisionModelSelection | null {
  const path = selectionFilePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VisionModelSelection>;
    if (
      typeof parsed.provider === "string" && parsed.provider
      && typeof parsed.modelId === "string" && parsed.modelId
    ) {
      return { provider: parsed.provider, modelId: parsed.modelId };
    }
  } catch {
    /* 文件损坏时回退自动选择 */
  }
  return null;
}

/** 持久化视觉代理模型选择；传 null 表示自动选择。 */
export function setVisionModelSelection(selection: VisionModelSelection | null): void {
  const path = selectionFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify(selection ?? null));
}

/**
 * 解析实际使用的视觉模型，优先级：
 *   1) 请求里显式携带的选择（客户端已持久化选择的副本）
 *   2) 本地持久化的选择
 *   3) models.json 自动扫描的第一个视觉模型
 * 显式/持久化选择指向的模型不可用（未找到、不支持图片、缺 baseUrl/apiKey）
 * 时自动回退到扫描，保证粘贴图片始终有兜底。
 */
export function resolveVisionModel(explicit?: VisionModelSelection | null): {
  model: VisionModelInfo | null;
  matchedExplicit: boolean;
} {
  const candidates: Array<VisionModelSelection | null> = [
    explicit ?? null,
    getVisionModelSelection(),
  ];
  for (const sel of candidates) {
    if (!sel) continue;
    const match = findVisionModel(
      (m) => m.provider === sel.provider && m.modelId === sel.modelId,
    );
    if (match) return { model: match, matchedExplicit: true };
  }
  return { model: findVisionModel() ?? null, matchedExplicit: false };
}
