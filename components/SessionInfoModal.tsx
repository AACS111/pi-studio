/**
 * SessionInfoModal —— 会话信息浮窗（可拖动 + 可缩放）。
 *
 * 取代原先挂在顶栏下方的通栏 popover：改为一张独立浮窗，内容重排为
 * 「会话标识 → 4 个 KPI → Token 构成占比条 / 消息构成」四段，
 * 让「上下文占用」「总花费」这类关键信息一眼可见，而不是铺一排裸数字。
 *
 * 配色全部走主题变量（--accent / --accent-rgb / --text-* / --bg-*），
 * 深浅色主题下自动跟随用户自定义的 accent；仅告警色与轨道色在
 * globals.css 的 .session-info-modal 里按 html.dark 分主题给值。
 */
"use client";

import type { ReactNode } from "react";
import { DraggableResizableModal } from "@/components/DraggableResizableModal";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";

type CopyField = "file" | "id";

export function SessionInfoModal({
  stats,
  contextUsage,
  t,
  locale,
  copiedField,
  onCopy,
  onClose,
}: {
  stats: SessionStatsInfo | null;
  contextUsage: ContextUsage | null;
  t: (key: string, params?: Record<string, string | number>) => string;
  locale: string;
  copiedField: CopyField | null;
  onCopy: (field: CopyField, value: string) => void;
  onClose: () => void;
}) {
  const fmt = (n: number) => n.toLocaleString(locale);
  const compact = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
      : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
        : String(n);

  const ctx = contextUsage ?? stats?.contextUsage ?? null;
  const tokens = stats?.tokens ?? null;
  const totalTokens = tokens?.total ?? 0;
  const cost = stats?.cost ?? 0;
  const costCurrency = stats?.costCurrency ?? "USD";
  const costSymbol = costCurrency === "CNY" ? "¥" : "$";
  // 人民币金额精度到分；美元保留 4 位（多数会话是几美分级别）
  const money = (v: number) =>
    costCurrency === "CNY"
      ? (v >= 0.01 ? `¥${v.toFixed(2)}` : "<¥0.01")
      : (v >= 0.01 ? `$${v.toFixed(2)}` : "<$0.01");
  const costMeta = stats?.costMeta;
  const tierLabel = costMeta?.tier === "offPeak" ? t("session.tierOffPeak")
    : costMeta?.tier === "peak" ? t("session.tierPeak")
      : costMeta?.tier === "mixed" ? t("session.tierMixed")
        : null;

  // Token 构成：四段同色系（accent 由深到浅），条与图例共用同一组颜色。
  const tokenSegments = tokens
    ? ([
      { key: "input", label: t("session.input"), value: tokens.input, color: "var(--accent)" },
      { key: "output", label: t("session.output"), value: tokens.output, color: "rgba(var(--accent-rgb), 0.62)" },
      { key: "cacheRead", label: t("session.cacheRead"), value: tokens.cacheRead, color: "rgba(var(--accent-rgb), 0.40)" },
      { key: "cacheWrite", label: t("session.cacheWrite"), value: tokens.cacheWrite, color: "rgba(var(--accent-rgb), 0.22)" },
    ] as const).filter((s) => s.value > 0)
    : [];
  const segmentSum = tokenSegments.reduce((acc, s) => acc + s.value, 0);

  const messageRows = stats
    ? [
      { key: "user", label: t("session.user"), value: stats.userMessages },
      { key: "assistant", label: t("session.assistant"), value: stats.assistantMessages },
      { key: "toolCalls", label: t("session.toolCalls"), value: stats.toolCalls },
      { key: "toolResults", label: t("session.toolResults"), value: stats.toolResults },
    ].filter((r) => r.value > 0)
    : [];
  const messageMax = Math.max(1, ...messageRows.map((r) => r.value));

  const ctxPct = ctx?.percent ?? null;
  const ctxLevel = ctxPct === null ? "ok" : ctxPct > 90 ? "danger" : ctxPct > 70 ? "warn" : "ok";
  const ctxColor = ctxLevel === "danger" ? "var(--si-danger)" : ctxLevel === "warn" ? "var(--si-warn)" : "var(--accent)";

  const sessionTitle = stats?.sessionName
    || (stats?.sessionFile ? stats.sessionFile.split(/[\\/]/).pop() ?? "" : "")
    || stats?.sessionId?.slice(0, 12)
    || t("session.title");

  const copyButton = (field: CopyField, value: string) => {
    const copied = copiedField === field;
    return (
      <button
        type="button"
        className={`si-copy${copied ? " si-copy-done" : ""}`}
        title={copied ? t("session.copied") : t(field === "file" ? "session.copyFile" : "session.copyId")}
        aria-label={copied ? t("session.copied") : t(field === "file" ? "session.copyFile" : "session.copyId")}
        onClick={() => onCopy(field, value)}
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
    );
  };

  const kpiCard = (key: string, label: string, value: ReactNode, sub: ReactNode, extra?: ReactNode) => (
    <div className="si-kpi" key={key}>
      <div className="si-kpi-label">{label}</div>
      <div className="si-kpi-value">{value}</div>
      {extra}
      <div className="si-kpi-sub">{sub}</div>
    </div>
  );

  return (
    <DraggableResizableModal
      title={t("session.title")}
      hint={t("session.modalHint")}
      onClose={onClose}
      width={760}
      height={580}
    >
      <div className="session-info-modal">
        {!stats ? (
          <div className="si-empty">{t("session.load")}</div>
        ) : (
          <>
            {/* ① 会话标识：名称 + 文件 / ID（可复制） */}
            <div className="si-identity">
              <div className="si-identity-name" title={sessionTitle}>{sessionTitle}</div>
              <div className="si-identity-rows">
                <div className="si-identity-row">
                  <span className="si-identity-key">{t("session.file")}</span>
                  <span className="si-identity-val" title={stats.sessionFile ?? t("session.inMemory")}>
                    {stats.sessionFile ?? t("session.inMemory")}
                  </span>
                  {stats.sessionFile ? copyButton("file", stats.sessionFile) : <span className="si-copy-spacer" />}
                </div>
                <div className="si-identity-row">
                  <span className="si-identity-key">{t("session.id")}</span>
                  <span className="si-identity-val" title={stats.sessionId}>{stats.sessionId}</span>
                  {copyButton("id", stats.sessionId)}
                </div>
              </div>
            </div>

            {/* ② KPI：上下文占用 / 总 Token / 费用 / 消息数 */}
            <div className="si-kpi-grid">
              {kpiCard(
                "context",
                t("session.contextUsage"),
                ctx?.contextWindow
                  ? (ctxPct !== null ? `${ctxPct.toFixed(1)}%` : "?")
                  : "—",
                ctx?.contextWindow
                  ? `${ctx.tokens !== null && ctx.tokens !== undefined ? compact(ctx.tokens) : "?"} / ${compact(ctx.contextWindow)}`
                  : t("session.inMemory"),
                ctx?.contextWindow ? (
                  <div className="si-ctx-track">
                    <div
                      className="si-ctx-fill"
                      style={{
                        width: `${Math.max(2, Math.min(100, ctxPct ?? 0))}%`,
                        background: ctxColor,
                      }}
                    />
                  </div>
                ) : null,
              )}
              {kpiCard(
                "tokens",
                t("session.tokens"),
                totalTokens > 0 ? compact(totalTokens) : "—",
                tokens && totalTokens > 0
                  ? `${t("session.input")} ${compact(tokens.input)} · ${t("session.output")} ${compact(tokens.output)}`
                  : t("session.inMemory"),
              )}
              {kpiCard(
                "cost",
                t("session.cost"),
                cost > 0 ? money(cost) : "—",
                cost > 0
                  ? [
                    stats?.costEstimated ? t("session.costEstimated") : null,
                    tierLabel,
                    costMeta?.label ?? null,
                  ].filter(Boolean).join(" · ")
                  : t("session.costUnknown"),
              )}
              {kpiCard(
                "messages",
                t("session.messages"),
                fmt(stats.totalMessages),
                `${t("session.user")} ${fmt(stats.userMessages)} · ${t("session.assistant")} ${fmt(stats.assistantMessages)}`,
              )}
            </div>

            {/* ③ 明细：Token 构成（占比条 + 图例） / 消息构成（按量条形） */}
            <div className="si-detail-grid">
              <div className="si-panel">
                <div className="si-panel-title">{t("session.tokenBreakdown")}</div>
                {tokenSegments.length > 0 ? (
                  <>
                    <div className="si-stack" role="img" aria-label={t("session.tokenBreakdown")}>
                      {tokenSegments.map((s) => (
                        <div
                          key={s.key}
                          className="si-stack-seg"
                          style={{ width: `${(s.value / segmentSum) * 100}%`, background: s.color }}
                          title={`${s.label} ${fmt(s.value)}`}
                        />
                      ))}
                    </div>
                    <div className="si-legend">
                      {tokenSegments.map((s) => (
                        <div className="si-legend-row" key={s.key}>
                          <span className="si-swatch" style={{ background: s.color }} />
                          <span className="si-legend-label">{s.label}</span>
                          <span className="si-legend-value">{fmt(s.value)}</span>
                          <span className="si-legend-pct">{((s.value / segmentSum) * 100).toFixed(1)}%</span>
                        </div>
                      ))}
                      <div className="si-legend-row si-legend-total">
                        <span className="si-swatch si-swatch-none" />
                        <span className="si-legend-label">{t("session.total")}</span>
                        <span className="si-legend-value">{fmt(totalTokens)}</span>
                        <span className="si-legend-pct">100%</span>
                      </div>
                    </div>
                    {stats?.costEstimated && costMeta && cost > 0 && (
                      <div className="si-cost-detail">
                        <div className="si-cost-line">
                          <span>{t("session.costFrom", { model: costMeta.label ?? "", tier: tierLabel ?? "" })}</span>
                        </div>
                        <div className="si-cost-rows">
                          <span>{t("session.input")} {money(costMeta.breakdown.input)}</span>
                          <span>{t("session.cacheRead")} {money(costMeta.breakdown.cacheRead)}</span>
                          <span>{t("session.output")} {money(costMeta.breakdown.output)}</span>
                        </div>
                        {costMeta.unit && (
                          <div className="si-cost-unit">
                            {t("session.unitPrices", {
                              input: `${costSymbol}${costMeta.unit.input}`,
                              output: `${costSymbol}${costMeta.unit.output}`,
                              cacheRead: `${costSymbol}${costMeta.unit.cacheRead}`,
                            })}
                          </div>
                        )}                      </div>
                    )}
                  </>
                ) : (
                  <div className="si-panel-empty">{t("session.inMemory")}</div>
                )}
              </div>

              <div className="si-panel">
                <div className="si-panel-title">{t("session.messagesBreakdown")}</div>
                {messageRows.length > 0 ? (
                  <div className="si-bars">
                    {messageRows.map((r) => (
                      <div className="si-bar-row" key={r.key}>
                        <span className="si-bar-label">{r.label}</span>
                        <span className="si-bar-track">
                          <span
                            className="si-bar-fill"
                            style={{ width: `${Math.max(3, (r.value / messageMax) * 100)}%` }}
                          />
                        </span>
                        <span className="si-bar-value">{fmt(r.value)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="si-panel-empty">{t("session.inMemory")}</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </DraggableResizableModal>
  );
}
