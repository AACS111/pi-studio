/**
 * 模型价格表（人民币）+ Token 费用估算。
 *
 * 为什么要本地价目表：pi 会话文件里的 `usage.cost` 全部由 provider 回传，
 * DeepSeek 这条链路（以及多数走自定义 baseUrl / 套餐的 provider）回传的是
 * 全 0（实测整个会话 63 条 assistant 消息 cost.total 均为 0），所以面板上
 * 「费用」永远是空的。而 pi-ai 内置的 `cost` 字段是**美元**（deepseek-flash
 * 内置 0.14/0.28 美元/百万，与官方人民币价 1~2 元/4~8 元对不上），
 * 因此这里按官方价目表内置一份人民币单价，客户端自行估算。
 *
 * 计费口径（以 DeepSeek 官方「模型细节」价格表为准）：
 * - 单位：元 / 百万 token；
 * - 分**高峰**与**空闲**两档，空闲时段为北京时间 **周六/周日全天** 以及工作日 00:30–08:30，
 *   单价约为高峰的 5 折；
 * - 输入按**缓存命中**（cacheRead）与**未命中**（input）分别计价；
 * - 输出（含思考 token）单独计价；
 * - DeepSeek 当前不对显式缓存写入计费（cacheWrite = 0）。
 *
 * provider 一旦回传了非零账单（`usage.cost.total > 0`），优先采用 provider 的
 * 数值，本模块只作为兜底估算。
 */

/** 人民币 token 单价，单位：元 / 百万 token */
export interface CnyTokenPrice {
  /** 输入 · 缓存命中 */
  cacheRead: number;
  /** 输入 · 缓存未命中 */
  input: number;
  /** 输出（含思考） */
  output: number;
  /** 显式缓存写入（DeepSeek 无此项，恒为 0） */
  cacheWrite: number;
}

export interface CnyPricing {
  currency: "CNY";
  /** 高峰时段单价 */
  peak: CnyTokenPrice;
  /** 空闲时段单价 */
  offPeak: CnyTokenPrice;
  /** 价目表对应的模型名（用于 UI 展示） */
  label: string;
}

/** 空闲（折扣）时段：① 北京时间 00:30 – 08:30；② 周六 / 周日全天 */
const OFF_PEAK_WINDOWS: Array<{ startMinute: number; endMinute: number }> = [
  { startMinute: 30, endMinute: 8 * 60 + 30 },
];

const BEIJING_OFFSET_MINUTES = 8 * 60;

/** 北京时间（UTC+8）的当日分钟数；不依赖运行环境的本地时区。 */
function beijingMinuteOfDay(timestampMs: number): number {
  const shifted = timestampMs + BEIJING_OFFSET_MINUTES * 60_000;
  const d = new Date(shifted);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** 北京时间（UTC+8）的星期（0 = 周日，6 = 周六）。 */
function beijingWeekday(timestampMs: number): number {
  return new Date(timestampMs + BEIJING_OFFSET_MINUTES * 60_000).getUTCDay();
}

/**
 * 模型价格目录。key 为 `provider:modelId`，同时登记官方别名
 * （旧模型名 deepseek-v4-flash / -0731 仍可调用，但按 Flash 价计费）。
 */
const MODEL_PRICING: Record<string, CnyPricing> = {
  "deepseek:deepseek-flash": {
    currency: "CNY",
    label: "deepseek-flash",
    offPeak: { cacheRead: 0.02, input: 1, output: 4, cacheWrite: 0 },
    peak: { cacheRead: 0.04, input: 2, output: 8, cacheWrite: 0 },
  },
  "deepseek:deepseek-v4-pro": {
    currency: "CNY",
    label: "deepseek-v4-pro",
    offPeak: { cacheRead: 0.15, input: 4.5, output: 13.5, cacheWrite: 0 },
    peak: { cacheRead: 0.30, input: 9, output: 27, cacheWrite: 0 },
  },
};

// 官方「模型细节」表里显式列出的别名（价格与对应主模型一致）。
const MODEL_ALIASES: Record<string, string> = {
  "deepseek:deepseek-v4-flash": "deepseek:deepseek-flash",
  "deepseek:deepseek-v4-flash-0731": "deepseek:deepseek-flash",
  "deepseek:deepseek-v4-flash-vision-exp": "deepseek:deepseek-flash",
  "deepseek:deepseek-v4-pro-0813": "deepseek:deepseek-v4-pro",
};

export function getModelPricing(provider?: string | null, model?: string | null): CnyPricing | null {
  if (!provider || !model) return null;
  const key = `${provider}:${model}`;
  return MODEL_PRICING[MODEL_ALIASES[key] ?? key] ?? null;
}

/**
 * 某一时刻是否处于空闲（折扣）时段。仅对配置了双档价的 provider 有意义。
 *
 * 规则（北京时间）：周六 / 周日全天为低谷；工作日仅 00:30–08:30 为低谷。
 */
export function isOffPeak(provider: string | null | undefined, timestampMs?: number): boolean {
  if (!timestampMs || !Number.isFinite(timestampMs)) return false;
  if (provider !== "deepseek") return false;
  const weekday = beijingWeekday(timestampMs);
  if (weekday === 0 || weekday === 6) return true;
  const minute = beijingMinuteOfDay(timestampMs);
  return OFF_PEAK_WINDOWS.some(({ startMinute, endMinute }) =>
    startMinute <= endMinute
      ? minute >= startMinute && minute < endMinute
      : minute >= startMinute || minute < endMinute,
  );
}

export interface MessageUsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export type CostTier = "peak" | "offPeak";

export interface MessageCost {
  amount: number;
  currency: "CNY" | "USD";
  /** true = 按内置价目表估算；false = provider 回传账单 */
  estimated: boolean;
  tier: CostTier | null;
  /** 单位：元 / 百万 token（仅估算时有值） */
  unit: CnyTokenPrice | null;
  /** 各部分金额（元），仅估算时有值 */
  breakdown: { input: number; cacheRead: number; cacheWrite: number; output: number } | null;
  label: string | null;
}

/**
 * 计算单条 assistant 消息的费用。
 *
 * @returns provider 账单优先；账单为 0 且价目表命中时返回人民币估算；都不可用返回 null。
 */
export function computeMessageCost(
  provider: string | undefined,
  model: string | undefined,
  usage: MessageUsageLike | undefined,
  timestampMs?: number,
): MessageCost | null {
  if (!usage) return null;

  const reported = usage.cost?.total ?? 0;
  if (reported > 0) {
    return {
      amount: reported,
      currency: "USD",
      estimated: false,
      tier: null,
      unit: null,
      breakdown: null,
      label: model ?? null,
    };
  }

  const pricing = getModelPricing(provider, model);
  if (!pricing) return null;

  const tier: CostTier = isOffPeak(provider, timestampMs) ? "offPeak" : "peak";
  const unit = pricing[tier];
  const per1M = (tokens: number | undefined, price: number) => ((tokens ?? 0) / 1_000_000) * price;
  const breakdown = {
    input: per1M(usage.input, unit.input),
    cacheRead: per1M(usage.cacheRead, unit.cacheRead),
    cacheWrite: per1M(usage.cacheWrite, unit.cacheWrite),
    output: per1M(usage.output, unit.output),
  };
  const amount = breakdown.input + breakdown.cacheRead + breakdown.cacheWrite + breakdown.output;
  if (amount <= 0) return null;

  return { amount, currency: "CNY", estimated: true, tier, unit, breakdown, label: pricing.label };
}
