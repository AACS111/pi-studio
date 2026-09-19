/**
 * lib/stream-rate.ts —— 流式输出速率测量（旧 MessageView 与 percho 消息流共用）。
 *
 * 口径：**字符/秒**（中文 1 字≈1 token，不再用 chars/4 估算），显示后缀沿用 t/s。
 * 算法：2 秒滞动窗口取瞬时速率 + 非对称 EMA（掉速 α=0.5 快反应、冲高 α=0.25 防尖刺）。
 * 之所以不用「整条消息累计平均」：那样越往后越粘，真掉速了数字还是绿的。
 *
 * 输入 chars 必须是**原始到达**字符数（不是 markstream 平滑插值后的显示文本），
 * 否则测出来的是打字机速度而不是模型速度。
 */
import { useEffect, useRef, useState } from "react";

export const RATE_SAMPLE_WINDOW_MS = 2000;
export const RATE_MIN_BASELINE_MS = 800;
export const RATE_EMA_UP = 0.25;
export const RATE_EMA_DOWN = 0.5;
export const RATE_FAST_MIN = 80;
export const RATE_OK_MIN = 40;
/** 采样间隔：300ms 足够跟手，又不至于每帧 setState */
export const RATE_TICK_MS = 300;

export interface RateSample {
  t: number;
  chars: number;
}

/** 用窗口内最早/最晚两个采样点算瞬时字符速率；样本不足或基线太短返回 null（不猜）。 */
export function computeStreamRate(samples: RateSample[], now: number): number | null {
  const win = samples.filter((s) => s.t >= now - RATE_SAMPLE_WINDOW_MS);
  if (win.length < 2) return null;
  const first = win[0];
  const last = win[win.length - 1];
  const spanMs = last.t - first.t;
  if (spanMs < RATE_MIN_BASELINE_MS) return null;
  return Math.max(0, (last.chars - first.chars) / (spanMs / 1000));
}

/** 非对称平滑：速率下降用大系数（尽快告警），上升用小系数（防抩毛刺）。 */
export function smoothRate(prev: number | null, next: number): number {
  if (prev === null) return next;
  const alpha = next < prev ? RATE_EMA_DOWN : RATE_EMA_UP;
  return prev + (next - prev) * alpha;
}

export type RateTier = "fast" | "ok" | "slow";

export function rateTier(cps: number): RateTier {
  if (cps >= RATE_FAST_MIN) return "fast";
  if (cps >= RATE_OK_MIN) return "ok";
  return "slow";
}

/** 色点与数字共用一个颜色 token（色点走 currentColor），避免第二套配色配方。 */
export const RATE_TIER_VAR: Record<RateTier, string> = {
  fast: "var(--rate-fast)",
  ok: "var(--rate-ok)",
  slow: "var(--rate-slow)",
};

/**
 * 订阅式测速：`active` 期间每 RATE_TICK_MS 采一次 `chars`。
 * 流结束后**保留最后一个值**（定格），由渲染层转灰；下一次 active 才清零重算。
 */
export function useStreamRate(active: boolean, chars: number): number | null {
  const [rate, setRate] = useState<number | null>(null);
  const charsRef = useRef(chars);
  charsRef.current = chars;
  const samplesRef = useRef<RateSample[]>([]);
  const emaRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    // 新一轮流式：丢掉上一轮的窗口与平滑值，从 0 重算
    samplesRef.current = [];
    emaRef.current = null;
    setRate(null);
    const id = setInterval(() => {
      const now = Date.now();
      const current = charsRef.current;
      if (current === 0) return;
      const samples = samplesRef.current;
      // 每 tick 都记样本（即使长度未变）：否则停滞超过窗口后只剩一个点，
      // computeStreamRate 会返回 null，速率冻结在旧值而不是继续走低到红档。
      samples.push({ t: now, chars: current });
      if (samples.length > 40) samples.splice(0, samples.length - 40);
      const instant = computeStreamRate(samples, now);
      if (instant === null) return;
      emaRef.current = smoothRate(emaRef.current, instant);
      setRate(emaRef.current);
    }, RATE_TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  return rate;
}
