/**
 * ContextDietSettings —— 上下文精简（pi-studio 对 @earendil-works/pi-ai 的 context-diet 补丁）
 * 的全局设置，读写 ~/.pi/agent/settings.json 的 contextDiet 段。
 *
 * 补丁改的是 convertMessages 拼请求体之前的「历史回放」：
 *   1. 历史 thinking：只保留最近一条 assistant 的 reasoning_content；
 *   2. 陈旧工具结果：超过 keepRecentToolResults 条、且长度 >= foldMinChars 的，折成一行占位符；
 *   3. 陈旧工具截图：只保留最近 keepRecentImages 张，其余换成占位符（省上传字节）。
 *
 * 实测（225 条历史 / 1 张截图 / deepseek-flash）：prompt tokens 109,867 → 63,130（−42.5%）。
 * 注意：209KB base64 截图只计费 794 prompt tokens，丢图省的是上传字节而非 token，
 * 所以 keepRecentImages 默认保守取 3。
 *
 * 参数落在这里，pi-ai 侧每 5s 重读一次；进程 env（PI_CONTEXT_DIET 等）优先级更高，
 * 便于临时 A/B 调试。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CONTEXT_DIET_DEFAULTS, type ContextDietSettings, type ContextDietSettingsPatch } from "./context-diet-shared";

export { CONTEXT_DIET_DEFAULTS, CONTEXT_DIET_RANGES } from "./context-diet-shared";
export type { ContextDietSettings, ContextDietSettingsPatch } from "./context-diet-shared";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

/** 测试注入点：覆盖 settings.json 路径（默认 = ~/.pi/agent/settings.json） */
let settingsPathOverride: string | undefined;
export function __setSettingsPathForTest(path: string | undefined): void {
  settingsPathOverride = path;
}

function settingsPath(): string {
  if (settingsPathOverride) return settingsPathOverride;
  return join(getAgentDir(), "settings.json");
}

function readRawSettings(): Record<string, unknown> {
  try {
    const path = settingsPath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 读取当前全局 context-diet 设置（文件缺失 / 无 contextDiet 段 → 返回默认值） */
export function readContextDietSettings(): ContextDietSettings {
  const raw = readRawSettings();
  const section = (raw.contextDiet ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof section.enabled === "boolean" ? section.enabled : CONTEXT_DIET_DEFAULTS.enabled,
    keepRecentToolResults: clampInt(section.keepRecentToolResults, CONTEXT_DIET_DEFAULTS.keepRecentToolResults, 0, 64),
    foldMinChars: clampInt(section.foldMinChars, CONTEXT_DIET_DEFAULTS.foldMinChars, 200, 100_000),
    keepRecentImages: clampInt(section.keepRecentImages, CONTEXT_DIET_DEFAULTS.keepRecentImages, 0, 32),
  };
}

/** 写入全局 context-diet 设置（原子写：临时文件 + rename；保留文件其他段） */
export function writeContextDietSettings(next: ContextDietSettingsPatch): ContextDietSettings {
  const raw = readRawSettings();
  const current = readContextDietSettings();
  const merged: ContextDietSettings = {
    enabled: next.enabled ?? current.enabled,
    keepRecentToolResults:
      next.keepRecentToolResults !== undefined
        ? clampInt(next.keepRecentToolResults, current.keepRecentToolResults, 0, 64)
        : current.keepRecentToolResults,
    foldMinChars:
      next.foldMinChars !== undefined
        ? clampInt(next.foldMinChars, current.foldMinChars, 200, 100_000)
        : current.foldMinChars,
    keepRecentImages:
      next.keepRecentImages !== undefined
        ? clampInt(next.keepRecentImages, current.keepRecentImages, 0, 32)
        : current.keepRecentImages,
  };
  raw.contextDiet = { ...merged };

  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf-8");
  renameSync(tmp, path);
  return merged;
}
