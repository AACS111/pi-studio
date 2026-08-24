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
 * 对 131072 窗口意味着触发点约 87.5% —— 太晚，长任务易在压缩前中断。
 * 本模块提供可调配置 + 推荐值（reserveTokens 取窗口 15%、keepRecentTokens 取窗口 10%）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

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

/** 根据 contextWindow 给出推荐阈值（触发点 ≈ 85% 使用率，压缩后保留 ≈ 15% 窗口） */
export function recommendedCompactionForWindow(contextWindow: number): CompactionSettings {
  const window = contextWindow > 0 ? contextWindow : 128000;
  return {
    enabled: true,
    reserveTokens: Math.round(window * 0.15),      // 触发点 = 窗口 - 15%
    keepRecentTokens: Math.round(window * 0.15),   // 压缩后保留 15%
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
  return {
    enabled: typeof section.enabled === "boolean" ? section.enabled : COMPACTION_DEFAULTS.enabled,
    reserveTokens: clampTokens(section.reserveTokens, COMPACTION_DEFAULTS.reserveTokens),
    keepRecentTokens: clampTokens(section.keepRecentTokens, COMPACTION_DEFAULTS.keepRecentTokens),
  };
}

/** settings.json 是否已有显式 compaction 配置（区分“用户配过”与“纯默认”） */
export function hasExplicitCompaction(): boolean {
  const raw = readRawSettings();
  const section = (raw.compaction ?? {}) as Record<string, unknown>;
  return typeof section === "object" && section !== null && Object.keys(section).length > 0;
}

/** 写入全局压缩设置（原子写：临时文件 + rename；保留文件其他段） */
export function writeCompactionSettings(next: Partial<CompactionSettings>): CompactionSettings {
  const raw = readRawSettings();
  const current = readCompactionSettings();
  const merged: CompactionSettings = {
    enabled: next.enabled ?? current.enabled,
    reserveTokens: next.reserveTokens !== undefined ? clampTokens(next.reserveTokens, current.reserveTokens) : current.reserveTokens,
    keepRecentTokens: next.keepRecentTokens !== undefined ? clampTokens(next.keepRecentTokens, current.keepRecentTokens) : current.keepRecentTokens,
  };
  raw.compaction = { enabled: merged.enabled, reserveTokens: merged.reserveTokens, keepRecentTokens: merged.keepRecentTokens };

  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf-8");
  renameSync(tmp, path);
  return merged;
}
