import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  MessageView,
  computeStreamRate,
  smoothRate,
  rateTier,
  RATE_SAMPLE_WINDOW_MS,
} = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderMessage(message) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message }),
    ),
  );
}

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

/* ── 流式速率：滞动窗口 / 非对称平滑 / 阈值分档 ───────────────── */

test("computeStreamRate returns chars per second over the sliding window", () => {
  const samples = [
    { t: 1000, chars: 0 },
    { t: 2000, chars: 60 },
    { t: 3000, chars: 120 },
  ];
  assert.equal(computeStreamRate(samples, 3000), 60);
});

test("computeStreamRate ignores samples older than the window", () => {
  // 旧样本落在 now-2000 之外，只能拿后两个算：(200-60)/1s = 140
  const samples = [
    { t: 1000, chars: 60 },
    { t: 3000, chars: 200 },
    { t: 4000, chars: 340 },
  ];
  assert.ok(1000 < 4000 - RATE_SAMPLE_WINDOW_MS);
  assert.equal(computeStreamRate(samples, 4000), 140);
});

test("computeStreamRate returns null when it cannot measure yet", () => {
  assert.equal(computeStreamRate([], 1000), null);
  assert.equal(computeStreamRate([{ t: 1000, chars: 12 }], 1000), null);
  // 窗口基线不足 800ms：不猜
  assert.equal(computeStreamRate([{ t: 3600, chars: 10 }, { t: 4000, chars: 20 }], 4000), null);
});

test("computeStreamRate reports zero (not null) when output stalled", () => {
  const samples = [
    { t: 3000, chars: 200 },
    { t: 4000, chars: 200 },
    { t: 5000, chars: 200 },
  ];
  assert.equal(computeStreamRate(samples, 5000), 0);
});

test("smoothRate reacts faster to slowdowns than to spikes", () => {
  assert.equal(smoothRate(null, 50), 50);
  const dropped = smoothRate(100, 20);
  const rose = smoothRate(20, 100);
  assert.equal(dropped, 60); // 100 + (20-100)*0.5 —— 1 秒内就跌到告警区
  assert.equal(rose, 40); // 20 + (100-20)*0.25 —— 尖刺不会把颜色瞬间刷绿
});

test("rateTier splits at the documented thresholds", () => {
  assert.equal(rateTier(80), "fast");
  assert.equal(rateTier(79.9), "ok");
  assert.equal(rateTier(40), "ok");
  assert.equal(rateTier(39.9), "slow");
  assert.equal(rateTier(0), "slow");
});
