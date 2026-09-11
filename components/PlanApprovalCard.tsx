"use client";
/**
 * PlanApprovalCard —— 计划模式的阶段确认/进度卡片。
 *
 * 计划模式下渲染在输入框上方：只读调研完成后，模型输出「计划：」编号列表，
 * 这里把它渲染成可勾选列表；用户勾选后点「开始执行」，只把选中的阶段发给
 * Agent 执行（见 hooks/useAgentSession 的 handleExecutePlan）。
 *
 * 执行中（planMode 已关闭）同一张卡片退化为只读进度条：按 `[DONE:n]`
 * 标记显示每个阶段的完成状态。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { PlanStage } from "@/lib/plan-mode";
import { stageStatus } from "@/lib/plan-mode";
import { useI18n } from "@/hooks/useI18n";
import { TodoCompleteIcon, TodoPendingIcon, TodoSpinnerIcon } from "./percho/icons";

interface Props {
  stages: PlanStage[];
  mode: "plan" | "executing";
  /** Agent 正在跑（计划模式下禁用执行按钮；执行中显示 spinner） */
  busy: boolean;
  /** 一次性执行选中的阶段 */
  onExecute: (steps: number[]) => void;
  /** 只执行某一个阶段（逐步确认） */
  onRunStep: (step: number) => void;
  /** 计划模式下「继续修改」：把焦点交回输入框 */
  onRevise?: () => void;
  /** 用于按会话持久化折叠态 */
  sessionId?: string | null;
}

const PLAN_CARD_COLLAPSED_PREFIX = "pi-web-plan-collapsed:";

function readCollapsed(key: string | null): boolean {
  if (!key || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PLAN_CARD_COLLAPSED_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

export function PlanApprovalCard({ stages, mode, busy, onExecute, onRunStep, onRevise, sessionId }: Props) {
  const { t } = useI18n();
  const pending = useMemo(() => stages.filter((stage) => !stage.done), [stages]);
  const doneCount = stages.length - pending.length;
  const runningStage = stages.find((stage) => stageStatus(stage) === "in_progress");
  const isPlan = mode === "plan";

  // 折叠态按「会话 + 模式」持久化（刷新后保持）
  const collapseKey = sessionId ? `${sessionId}:${mode}` : null;
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed(collapseKey));
  useEffect(() => {
    setCollapsed(readCollapsed(collapseKey));
  }, [collapseKey]);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      if (collapseKey) {
        try {
          window.localStorage.setItem(PLAN_CARD_COLLAPSED_PREFIX + collapseKey, next ? "1" : "0");
        } catch {
          // localStorage 不可用时只在本次会话内生效
        }
      }
      return next;
    });
  };

  // 默认全选；阶段变化（重新规划）时重置选择
  const signature = stages.map((stage) => `${stage.step}:${stage.text}`).join("|");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => {
    setSelected(new Set(pending.map((stage) => stage.step)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  if (stages.length === 0) return null;

  const toggle = (step: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step);
      else next.add(step);
      return next;
    });
  };

  const firstSelected = pending.find((stage) => selected.has(stage.step))?.step ?? null;
  const progressLabel = t("plan.progress", { done: doneCount, total: stages.length });
  const subtitle = !isPlan && collapsed && runningStage
    ? `${progressLabel} · ${runningStage.text}`
    : isPlan
      ? t("plan.subtitle", { count: stages.length })
      : progressLabel;

  return (
    <div style={{ margin: "0 auto 8px", maxWidth: 820, padding: "0 16px", width: "100%" }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          background: "var(--bg-panel)",
          boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -18px rgba(15,23,42,0.35)",
          overflow: "hidden",
        }}
      >
        {/* Header（点标题或箭头折叠/展开） */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderBottom: collapsed ? "none" : "1px solid var(--border)",
          }}
        >
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            title={collapsed ? t("plan.expand") : t("plan.collapse")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flex: 1,
              minWidth: 0,
              padding: 0,
              border: "none",
              background: "none",
              color: "inherit",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 18,
                height: 18,
                borderRadius: "var(--radius-xs)",
                background: isPlan ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent",
                color: "var(--accent)",
                flexShrink: 0,
              }}
            >
              {isPlan ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              ) : (
                <TodoSpinnerIcon size={14} className={busy ? "animate-spin" : ""} />
              )}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flexShrink: 0 }}>
              {isPlan ? t("plan.title") : t("plan.executing")}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {subtitle}
            </span>
          </button>
          {isPlan && (
            <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => setSelected(new Set(stages.map((stage) => stage.step)))}
                style={linkButtonStyle}
              >
                {t("plan.selectAll")}
              </button>
              <button type="button" onClick={() => setSelected(new Set())} style={linkButtonStyle}>
                {t("plan.clear")}
              </button>
            </span>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? t("plan.expand") : t("plan.collapse")}
            title={collapsed ? t("plan.expand") : t("plan.collapse")}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
              padding: 0,
              border: "none",
              background: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              borderRadius: "var(--radius-xs)",
            }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transform: collapsed ? "none" : "rotate(180deg)", transition: "transform 0.15s" }}
            >
              <polyline points="2.5 4.5 6 8 9.5 4.5" />
            </svg>
          </button>
        </div>

        {!collapsed && (
        <>
        {/* Stage list */}
        <ul style={{ margin: 0, padding: "6px 8px", listStyle: "none", maxHeight: 220, overflowY: "auto" }}>
          {stages.map((stage) => {
            const checked = selected.has(stage.step);
            const status = stageStatus(stage);
            const running = status === "in_progress";
            return (
              <li
                key={stage.step}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "5px 6px",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                {isPlan ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={stage.text}
                    onClick={() => toggle(stage.step)}
                    style={{
                      flexShrink: 0,
                      marginTop: 2,
                      width: 15,
                      height: 15,
                      padding: 0,
                      borderRadius: 4,
                      border: `1.5px solid ${checked ? "var(--accent)" : "var(--border)"}`,
                      background: checked ? "var(--accent)" : "transparent",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {checked && (
                      <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="1.5 5 4 7.5 8.5 2.5" />
                      </svg>
                    )}
                  </button>
                ) : stage.done ? (
                  <TodoCompleteIcon size={14} className="mt-[3px] shrink-0 text-green-500" />
                ) : running ? (
                  <TodoSpinnerIcon size={14} className={`mt-[3px] shrink-0 ${busy ? "animate-spin" : ""}`} />
                ) : (
                  <TodoPendingIcon size={14} className="mt-[3px] shrink-0 text-ink-faint" />
                )}
                <span
                  style={{
                    fontSize: 12,
                    lineHeight: 1.55,
                    color: stage.done || (!isPlan && !checked) ? "var(--text-muted)" : "var(--text)",
                    textDecoration: stage.done ? "line-through" : "none",
                    fontWeight: running ? 600 : undefined,
                    minWidth: 0,
                    wordBreak: "break-word",
                  }}
                >
                  <span style={{ color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", marginRight: 6 }}>
                    {stage.step}.
                  </span>
                  {stage.text}
                </span>
                {!isPlan && status === "pending" && !busy && (
                  <button
                    type="button"
                    onClick={() => onRunStep(stage.step)}
                    title={t("plan.runStep")}
                    aria-label={t("plan.runStep")}
                    style={{
                      flexShrink: 0,
                      alignSelf: "center",
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                      padding: "3px 8px",
                      borderRadius: "var(--radius-xs)",
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--text-muted)",
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    {t("plan.runStep")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {/* Footer */}
        {isPlan ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              borderTop: "1px solid var(--border)",
            }}
          >
            {onRevise && (
              <button type="button" onClick={onRevise} style={linkButtonStyle} title={t("plan.hint")}>
                {t("plan.revise")}
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              disabled={busy || firstSelected === null}
              onClick={() => firstSelected !== null && onRunStep(firstSelected)}
              title={t("plan.stepHint")}
              style={secondaryButtonStyle(busy || firstSelected === null)}
            >
              {t("plan.step")}
            </button>
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={() => onExecute(Array.from(selected))}
              style={primaryButtonStyle(busy || selected.size === 0)}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              {t("plan.executeCount", { count: selected.size })}
            </button>
          </div>
        ) : pending.length > 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              borderTop: "1px solid var(--border)",
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 0 }}>{t("plan.runHint")}</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              disabled={busy}
              onClick={() => onExecute(pending.map((stage) => stage.step))}
              style={secondaryButtonStyle(busy)}
            >
              {t("plan.executeRemaining", { count: pending.length })}
            </button>
          </div>
        ) : null}
        </>
        )}
      </div>
    </div>
  );
}

const linkButtonStyle: CSSProperties = {
  padding: "2px 6px",
  border: "none",
  background: "none",
  color: "var(--text-muted)",
  fontSize: 11,
  cursor: "pointer",
  borderRadius: "var(--radius-xs)",
};

function primaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 12px",
    borderRadius: "var(--radius-sm)",
    border: "none",
    background: disabled ? "var(--bg-hover)" : "var(--accent)",
    color: disabled ? "var(--text-dim)" : "#fff",
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function secondaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border)",
    background: "transparent",
    color: disabled ? "var(--text-dim)" : "var(--text-muted)",
    fontSize: 12,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}
