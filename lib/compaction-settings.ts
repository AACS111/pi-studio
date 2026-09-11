/**
 * CompactionSettings —— 上下文自动压缩全局设置（读写 ~/.pi/agent/settings.json 的 compaction 段）。
 *
 * pi 的 auto-compaction 触发条件（core/compaction/compaction.js）：
 *   shouldCompact(contextTokens, contextWindow, settings)
 *     => contextTokens > contextWindow - settings.reserveTokens
 *   keepRecentTokens：压缩后保留的最近 token 数（prepareCompaction 用）。
 *
 * 默认值（pi 内置）：
 *   enabled = true, reserveTokens = 16384, keepRecentTokens = 20000
 * 对 131072 窗口意味着触发点约 87.5%；对 1M 窗口（deepseek-flash）更是要涨到 ~98 万才动作 ——
 * 长会话（实测 283 轮 / 上下文 240k）永远触发不到，token 全花在重复回放历史上。
 *
 * pi-studio 的策略：不再用「窗口 − 固定 reserve」这种跟窗口无关的算法，而是按
 * **触发比例**（triggerRatio，默认 25%）算：触发点 = 窗口 × 25%，压缩后保留
 * min(窗口 15%, 触发点 50%)。比例本身存在 settings.json 的 compaction 段里
 * （pi 用 `settings.compaction?.reserveTokens ?? …` 普通属性读取，不校验多余字段）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  /** 触发点占模型窗口的比例（0.1~0.95）。undefined = 未启用比例策略 */
  triggerRatio?: number;
}

/** writeCompactionSettings 接受的补丁：triggerRatio 传 null 表示清除比例策略 */
export type CompactionSettingsPatch = Omit<Partial<CompactionSettings>, "triggerRatio"> & { triggerRatio?: number | null };

/** 测试注入点：覆盖 settings.json 路径（默认 = ~/.pi/agent/settings.json） */
let settingsPathOverride: string | undefined;
export function __setSettingsPathForTest(path: string | undefined): void {
  settingsPathOverride = path;
}

export const COMPACTION_DEFAULTS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** 默认触发点：模型窗口的 25% */
export const COMPACTION_TRIGGER_RATIO_DEFAULT = 0.25;

/** 设置面板可选项（比例值，非百分比） */
export const COMPACTION_TRIGGER_RATIO_OPTIONS = [0.25, 0.4, 0.6, 0.85] as const;

/** 比例合法区间：小于它没意义（压缩比压缩本身还频繁），大于它等于没优化 */
export function clampTriggerRatio(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(0.95, Math.max(0.1, value));
}

/**
 * 按「窗口 × 触发比例」给出阈值。
 *   触发点 tokens = 窗口 × ratio
 *   reserveTokens = 窗口 − 触发点（pi 的判定式：context > contextWindow − reserveTokens）
 *   keepRecentTokens = min(窗口 15%, 触发点 25%)，且不超过触发点 50%
 */
export function recommendedCompactionForWindow(
  contextWindow: number,
  triggerRatio: number = COMPACTION_TRIGGER_RATIO_DEFAULT,
): CompactionSettings {
  const window = contextWindow > 0 ? contextWindow : 128000;
  const ratio = clampTriggerRatio(triggerRatio) ?? COMPACTION_TRIGGER_RATIO_DEFAULT;
  const triggerTokens = Math.round(window * ratio);
  const keepCap = Math.min(Math.round(window * 0.15), Math.round(triggerTokens * 0.25));
  return {
    enabled: true,
    reserveTokens: Math.max(1024, window - triggerTokens),
    keepRecentTokens: Math.max(1024, Math.min(keepCap, Math.round(triggerTokens * 0.5))),
    triggerRatio: ratio,
  };
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

function clampTokens(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1024, Math.min(1_000_000, n));
}

/** 读取当前全局压缩设置（文件不存在 / 无 compaction 段 → 返回 pi 内置默认值） */
export function readCompactionSettings(): CompactionSettings {
  const raw = readRawSettings();
  const section = (raw.compaction ?? {}) as Record<string, unknown>;
  const settings: CompactionSettings = {
    enabled: typeof section.enabled === "boolean" ? section.enabled : COMPACTION_DEFAULTS.enabled,
    reserveTokens: clampTokens(section.reserveTokens, COMPACTION_DEFAULTS.reserveTokens),
    keepRecentTokens: clampTokens(section.keepRecentTokens, COMPACTION_DEFAULTS.keepRecentTokens),
  };
  const ratio = clampTriggerRatio(section.triggerRatio);
  if (ratio !== undefined) settings.triggerRatio = ratio;
  return settings;
}

/** settings.json 是否已有显式 compaction 配置（区分“用户配过”与“纯默认”） */
export function hasExplicitCompaction(): boolean {
  const raw = readRawSettings();
  const section = (raw.compaction ?? {}) as Record<string, unknown>;
  return typeof section === "object" && section !== null && Object.keys(section).length > 0;
}

/** 写入全局压缩设置（原子写：临时文件 + rename；保留文件其他段） */
export function writeCompactionSettings(next: CompactionSettingsPatch): CompactionSettings {
  const raw = readRawSettings();
  const current = readCompactionSettings();
  const merged: CompactionSettings = {
    enabled: next.enabled ?? current.enabled,
    reserveTokens: next.reserveTokens !== undefined ? clampTokens(next.reserveTokens, current.reserveTokens) : current.reserveTokens,
    keepRecentTokens: next.keepRecentTokens !== undefined ? clampTokens(next.keepRecentTokens, current.keepRecentTokens) : current.keepRecentTokens,
  };
  // next.triggerRatio === null → 清除比例策略；undefined → 保留当前值
  const ratio = next.triggerRatio === null
    ? undefined
    : clampTriggerRatio(next.triggerRatio ?? current.triggerRatio);
  if (ratio !== undefined) merged.triggerRatio = ratio;
  const section: Record<string, unknown> = { enabled: merged.enabled, reserveTokens: merged.reserveTokens, keepRecentTokens: merged.keepRecentTokens };
  if (ratio !== undefined) section.triggerRatio = ratio;
  raw.compaction = section;

  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf-8");
  renameSync(tmp, path);
  return merged;
}
