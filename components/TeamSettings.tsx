/**
 * TeamSettings —— 项目组设置（Phase 1B，补 TeamSettings 表单页）。
 *  - 角色（Agents）配置：列表增删改，从角色库添加，字段覆盖 AgentDef 全量。
 *  - 工作流（Transitions）配置：边列表增删改（from/to/event/condition/priority/enabled）。
 *  - 团队参数（Team）：入口角色/路由模式/四保险限制/上下文范围/返工边。
 *  - 保存 = PATCH /api/teams/:sessionId（整体提交）；校验结果实时显示。
 *
 * 数据流：本地 draft state → 保存时整体 PATCH → 重新拉取详情刷新。
 * 不落事件流（配置变更落 config_updated 事件属 Phase 2，见设计稿 §1C）。
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ModelSelect } from "./ModelSelect";
import { WorkflowEditor, GATEWAY_STYLE } from "./WorkflowEditor";
import { ExpandCanvasOverlay } from "./ExpandCanvasOverlay";
import { DraggableResizableModal } from "./DraggableResizableModal";
import { EmojiPicker, ToolPicker } from "./AgentFieldPickers";
import { THINKING_LEVELS } from "@/lib/team/ui-constants";
import type {
  AgentDef,
  AgentLibraryItem,
  ExecutionMode,
  GatewayDef,
  GatewayType,
  RoutingMode,
  TeamDef,
  ValidationIssue,
  WorkflowValidationResult,
} from "@/lib/team/types";

interface Props {
  sessionId: string;
  onClose: () => void;
  /** 打开时展开并定位到指定角色（TeamChat 点击角色 chip 进入） */
  initialAgentId?: string;
  /** 保存成功回调（让 TeamChat 刷新角色 chips） */
  onSaved?: () => void;
}

type Tab = "agents" | "workflow" | "team";

const ROUTING_MODES: RoutingMode[] = ["strict", "hybrid", "autonomous"];

/** 执行模式：仅 custom 在设置里显示流程图画布；流程模式使用内置流程，无画布 */
const EXEC_MODES: { id: ExecutionMode; label: string; desc: string }[] = [
  { id: "auto", label: "系统判断", desc: "按复杂度自动分流（simple→单独，complex→多角色编排）" },
  { id: "solo", label: "单独", desc: "入口角色（leader）带全套工具单会话闭环，等同普通会话" },
  { id: "serial", label: "串行", desc: "内置串行工作流（组长→产品→开发→测试+返工闭环）" },
  { id: "parallel", label: "并行", desc: "内置并行网关（分叉+汇聚+交叉验证）" },
  { id: "custom", label: "自定义", desc: "使用你自己在画布上画的流程（此项才会显示工作流画布）" },
];
const ROUTING_POLICIES = ["inherit", "strict", "hybrid", "autonomous"];
const CONTEXT_SCOPES = ["structured", "summary", "recent"];

export function TeamSettings({ sessionId, onClose, initialAgentId, onSaved }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("agents");
  const [team, setTeam] = useState<TeamDef | null>(null);
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(null);
  const [library, setLibrary] = useState<AgentLibraryItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(initialAgentId ? { [initialAgentId]: true } : {});
  const [canvasExpanded, setCanvasExpanded] = useState(false);

  /** 拉取团队详情 + 校验 + 角色库 */
  const load = useCallback(async () => {
    try {
      const [teamRes, libRes] = await Promise.all([
        fetch(`/api/teams/${sessionId}`),
        fetch("/api/teams/agents/library"),
      ]);
      const teamData = await teamRes.json();
      if (!teamRes.ok) throw new Error(teamData.error ?? `HTTP ${teamRes.status}`);
      setTeam(teamData.team);
      setValidation(teamData.validation ?? null);
      if (libRes.ok) {
        const libData = await libRes.json();
        setLibrary(libData.items ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 执行模式非 custom 时不展示工作流画布：若当前停留在 workflow tab 则回退到 agents
  useEffect(() => {
    if (team && tab === "workflow" && team.executionMode !== "custom") {
      setTab("agents");
    }
  }, [team, tab]);

  /** 保存：整体 PATCH，提交后重新拉取 */
  const handleSave = async () => {
    if (!team || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/teams/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: team.name,
          agents: team.agents,
          transitions: team.transitions,
          gateways: team.gateways,
          nodePositions: team.nodePositions,
          reworkEdges: team.reworkEdges,
          entryAgentId: team.entryAgentId,
          defaultRoutingMode: team.defaultRoutingMode,
          executionMode: team.executionMode,
          maxHops: team.maxHops,
          maxReworkRounds: team.maxReworkRounds,
          maxRunMinutes: team.maxRunMinutes,
          contextScope: team.contextScope,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const updateTeam = useCallback((patch: Partial<TeamDef>) => {
    setTeam((prev) => (prev ? { ...prev, ...patch, updatedAt: Date.now() } : prev));
  }, []);

  // —— 角色操作 ——
  const addAgentFromLibrary = (libId: string) => {
    if (!team) return;
    const item = library.find((i) => i.id === libId);
    if (!item) return;
    // 组内唯一 id：冲突加 -n 后缀
    let id = item.id;
    let n = 2;
    while (team.agents.some((a) => a.id === id)) id = `${item.id}-${n++}`;
    const agent: AgentDef = {
      id,
      name: item.name,
      emoji: item.emoji,
      role: item.role,
      model: item.model ?? "",
      systemPrompt: item.systemPrompt,
      toolNames: item.toolNames?.length ? item.toolNames : ["read", "bash", "edit", "write", "grep", "find", "ls"],
      skillIds: item.skillIds,
      workspace: { mode: "team" },
    };
    const isFirstAgent = team.agents.length === 0;
    updateTeam({
      agents: [...team.agents, agent],
      ...(isFirstAgent || !team.entryAgentId ? { entryAgentId: id } : {}),
    });
    setExpanded((e) => ({ ...e, [id]: true }));
  };

  const addBlankAgent = (position?: { x: number; y: number }) => {
    if (!team) return;
    const id = `agent-${team.agents.length + 1}`;
    const agent: AgentDef = {
      id,
      name: `角色 ${team.agents.length + 1}`,
      emoji: "🤖",
      role: "职责描述",
      model: "",
      systemPrompt: `你是${`角色 ${team.agents.length + 1}`}。\n\n【协作规则】\n- 每次执行你会收到「工作上下文」（任务、进度、最近消息、产物清单），基于它开展工作。\n\n【你的职责】\n1. 完成分配给你的任务。\n2. 产物路径写清楚，交接给下一个角色时让对方能 read 验证。\n\n【交接协议】\n- 完成后调用 team_handoff 交接：写清交接对象、工作摘要、产物路径。`,
      toolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      workspace: { mode: "team" },
    };
    const isFirstAgent = team.agents.length === 0;
    updateTeam({
      agents: [...team.agents, agent],
      ...(position ? { nodePositions: { ...(team.nodePositions ?? {}), [id]: position } } : {}),
      ...(isFirstAgent || !team.entryAgentId ? { entryAgentId: id } : {}),
    });
    setExpanded((e) => ({ ...e, [id]: true }));
  };

  const updateAgent = (id: string, patch: Partial<AgentDef>) => {
    if (!team) return;
    updateTeam({ agents: team.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  };

  const deleteAgent = (id: string) => {
    if (!team) return;
    if (id === team.entryAgentId) return;
    const nextAgents = team.agents.filter((a) => a.id !== id);
    // 级联删除引用该角色的边
    const nextTransitions = team.transitions.filter((tr) => tr.from !== id && tr.to !== id);
    updateTeam({ agents: nextAgents, transitions: nextTransitions });
  };


  // —— 网关操作 ——
  const addGateway = (type: GatewayType, position?: { x: number; y: number }) => {
    if (!team) return;
    const base = team.gateways ?? [];
    let n = base.length + 1;
    let id = `gw-${n}`;
    while (team.agents.some((a) => a.id === id) || base.some((g) => g.id === id)) {
      n++;
      id = `gw-${n}`;
    }
    const gw: GatewayDef = { id, type, name: `${GATEWAY_STYLE[type].label}网关 ${n}`, description: "" };
    updateTeam({
      gateways: [...base, gw],
      ...(position ? { nodePositions: { ...(team.nodePositions ?? {}), [id]: position } } : {}),
    });
    setExpanded((e) => ({ ...e, [id]: true }));
  };

  const updateGateway = (id: string, patch: Partial<GatewayDef>) => {
    if (!team) return;
    updateTeam({ gateways: (team.gateways ?? []).map((g) => (g.id === id ? { ...g, ...patch } : g)) });
  };

  const deleteGateway = (id: string) => {
    if (!team) return;
    updateTeam({
      gateways: (team.gateways ?? []).filter((g) => g.id !== id),
      // 级联删除引用该网关的边
      transitions: team.transitions.filter((tr) => tr.from !== id && tr.to !== id),
    });
  };

  const reworkEdgesText = useMemo(
    () => (team?.reworkEdges ?? []).map((e) => `${e.from},${e.to}`).join("\n"),
    [team?.reworkEdges],
  );

  const setReworkEdgesText = (text: string) => {
    if (!team) return;
    const edges = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [from, to] = line.split(",").map((s) => s.trim());
        return from && to ? { from, to } : null;
      })
      .filter((e): e is { from: string; to: string } => e !== null);
    updateTeam({ reworkEdges: edges.length ? edges : undefined });
  };

  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];

  /** 校验项点击定位：跳到对应 tab 并展开受影响节点 */
  const focusIssue = useCallback(
    (issue: ValidationIssue) => {
      if (issue.agentId && team?.agents.some((a) => a.id === issue.agentId)) {
        setTab("agents");
        setExpanded((e) => ({ ...e, [issue.agentId as string]: true }));
        return;
      }
      if (issue.transitionId && team?.transitions.some((tr) => tr.id === issue.transitionId)) {
        // 非 custom 模式不展示工作流画布：跳到团队参数（执行模式）提示
        setTab(team?.executionMode === "custom" ? "workflow" : "team");
        return;
      }
      // 无具体节点归属（如 maxHops/入口）默认落到工作流画布 / 团队参数
      setTab(team?.executionMode === "custom" ? "workflow" : "team");
    },
    [team],
  );

  if (!team) {
    return (
      <DraggableResizableModal title="⚙️ 项目组设置" hint="" onClose={onClose} width={860} height={720}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", fontSize: 14, color: "var(--text-muted)" }}>
          {error ?? "加载中…"}
        </div>
      </DraggableResizableModal>
    );
  }

  return (
    <DraggableResizableModal title={`⚙️ ${t("team.settings.title")}`} hint="" onClose={onClose} width={860} height={720}>
      {/* Tabs */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 12 }}>
        {(["agents", "workflow", "team"] as Tab[])
          .filter((key) => key !== "workflow" || team.executionMode === "custom")
          .map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              ...styles.tab,
              ...(tab === key ? styles.tabActive : {}),
            }}
          >
            {t(`team.settings.${key === "agents" ? "agentsTab" : key === "workflow" ? "workflowTab" : "teamTab"}`)}
            {key === "agents" && team.agents.length > 0 && <span style={styles.tabCount}>{team.agents.length}</span>}
            {key === "workflow" && (team.transitions.length + (team.gateways?.length ?? 0)) > 0 && <span style={styles.tabCount}>{team.transitions.length + (team.gateways?.length ?? 0)}</span>}
          </button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
        {tab === "agents" && (
          <>
            {/* 添加角色 */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    addAgentFromLibrary(e.target.value);
                    e.target.value = "";
                  }
                }}
                style={{ ...styles.input, flex: 1, minWidth: 180 }}
              >
                <option value="">{t("team.settings.fromLibrary")}…</option>
                {library.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.emoji ?? "🤖"} {item.name}（{item.role}）
                  </option>
                ))}
              </select>
              <button onClick={() => addBlankAgent()} style={styles.btnSecondary}>+ {t("team.settings.addAgent")}</button>
            </div>

            {/* 角色列表 */}
            {team.agents.map((agent) => {
              const isEntry = agent.id === team.entryAgentId;
              const open = !!expanded[agent.id];
              return (
                <div key={agent.id} style={styles.agentCard}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexWrap: "wrap" }}
                    onClick={() => setExpanded((e) => ({ ...e, [agent.id]: !open }))}
                  >
                    <span style={{ fontSize: 16 }}>{agent.emoji ?? "🤖"}</span>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{agent.name}</span>
                    {isEntry && (
                      <span style={styles.entryBadge}>▶ {t("team.settings.entry")}</span>
                    )}
                    <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {agent.role} · {agent.model || t("team.settings.agentModel")}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{open ? "▴" : "▾"}</span>
                  </div>

                  {open && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                      <div style={styles.grid2}>
                        <Field label={t("team.settings.agentName")}>
                          <input value={agent.name} onChange={(e) => updateAgent(agent.id, { name: e.target.value })} style={styles.input} />
                        </Field>
                        <Field label={t("team.settings.agentEmoji")}>
                          <EmojiPicker value={agent.emoji} onChange={(v) => updateAgent(agent.id, { emoji: v })} placeholder={t("team.settings.agentEmoji")} />
                        </Field>
                      </div>
                      <Field label={t("team.settings.agentRole")}>
                        <input value={agent.role} onChange={(e) => updateAgent(agent.id, { role: e.target.value })} style={styles.input} />
                      </Field>
                      <Field label={t("team.settings.agentModel")}>
                        <ModelSelect
                          value={agent.model}
                          onChange={(v) => updateAgent(agent.id, { model: v })}
                          cwd={team.cwd}
                          style={styles.input}
                        />
                      </Field>
                      <Field label={t("team.settings.agentPrompt")}>
                        <textarea
                          value={agent.systemPrompt}
                          onChange={(e) => updateAgent(agent.id, { systemPrompt: e.target.value })}
                          style={{ ...styles.input, minHeight: 120, fontFamily: "var(--font-mono)", fontSize: 12 }}
                        />
                      </Field>
                      <Field label={t("team.settings.agentTools")}>
                        <ToolPicker
                          value={agent.toolNames}
                          onChange={(v) => updateAgent(agent.id, { toolNames: v })}
                          placeholder={t("team.settings.agentTools")}
                        />
                      </Field>
                      <Field label={t("team.settings.agentSkillIds")}>
                        <input
                          value={(agent.skillIds ?? []).join(", ")}
                          onChange={(e) => updateAgent(agent.id, { skillIds: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                          style={styles.input}
                        />
                      </Field>
                      <Field label="期望产出（验收标准）">
                        <textarea
                          value={agent.expectation ?? ""}
                          onChange={(e) => updateAgent(agent.id, { expectation: e.target.value })}
                          placeholder="如：产出需求文档路径与验收标准；改动真实写入项目并跑通 typecheck/测试"
                          style={{ ...styles.input, minHeight: 56, fontFamily: "var(--font-mono)", fontSize: 12 }}
                        />
                      </Field>
                      <div style={styles.grid2}>
                        <Field label={t("team.settings.agentRouting")}>
                          <select
                            value={agent.routingPolicy ?? "inherit"}
                            onChange={(e) => updateAgent(agent.id, { routingPolicy: e.target.value as AgentDef["routingPolicy"] })}
                            style={styles.input}
                          >
                            {ROUTING_POLICIES.map((r) => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </select>
                        </Field>
                        <Field label={t("team.settings.agentContext")}>
                          <select
                            value={agent.contextPolicy?.scope ?? "structured"}
                            onChange={(e) =>
                              updateAgent(agent.id, {
                                contextPolicy: {
                                  scope: e.target.value as "structured" | "summary" | "recent",
                                  recentCount: agent.contextPolicy?.recentCount,
                                },
                              })
                            }
                            style={styles.input}
                          >
                            {CONTEXT_SCOPES.map((s) => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <div style={styles.grid2}>
                        <Field label={t("team.settings.agentThinking")}>
                          <select
                            value={agent.thinkingLevel ?? "auto"}
                            onChange={(e) =>
                              updateAgent(agent.id, {
                                thinkingLevel: e.target.value === "auto" ? undefined : (e.target.value as AgentDef["thinkingLevel"]),
                              })
                            }
                            style={styles.input}
                          >
                            {THINKING_LEVELS.map((lv) => (
                              <option key={lv} value={lv}>{lv}</option>
                            ))}
                          </select>
                        </Field>
                        <Field label={t("team.settings.agentMaxTurns")}>
                          <input
                            type="number"
                            value={agent.maxTurns ?? 20}
                            onChange={(e) => updateAgent(agent.id, { maxTurns: Number(e.target.value) || undefined })}
                            style={styles.input}
                          />
                        </Field>
                      </div>
                      <Field label={t("team.settings.agentMaxOutput")}>
                        <input
                          type="number"
                          value={agent.maxOutputChars ?? 4000}
                          onChange={(e) => updateAgent(agent.id, { maxOutputChars: Number(e.target.value) || undefined })}
                          style={styles.input}
                        />
                      </Field>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={() => {
                            if (isEntry) {
                              setError(t("team.settings.cannotDeleteEntry"));
                              return;
                            }
                            deleteAgent(agent.id);
                          }}
                          style={styles.btnDanger}
                          disabled={isEntry}
                          title={isEntry ? t("team.settings.cannotDeleteEntry") : undefined}
                        >
                          🗑 {t("team.settings.deleteAgent")}
                        </button>
                        {!isEntry && (
                          <button
                            onClick={() => updateTeam({ entryAgentId: agent.id })}
                            style={styles.btnSecondary}
                            title={t("team.settings.entryAgent")}
                          >
                            ▶ {t("team.settings.entry")}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {tab === "workflow" && (
          <>
            {/* 工作流可视化编辑（画布：拖拽建边、双击边/节点就近编辑、Delete 删除；右上角 ⛶ 可展开大画布） */}
            {!canvasExpanded && team.agents.length > 0 && (
              <WorkflowEditor
                agents={team.agents}
                transitions={team.transitions}
                entryAgentId={team.entryAgentId}
                reworkEdges={team.reworkEdges}
                gateways={team.gateways}
                nodePositions={team.nodePositions}
                onEditAgent={(id) => {
                  setTab("agents");
                  setExpanded((e) => ({ ...e, [id]: true }));
                }}
                onCreateEdge={(from, to) => {
                  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                  updateTeam({
                    transitions: [
                      ...team.transitions,
                      { id, from, to, priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
                    ],
                  });
                }}
                onDeleteEdge={(transitionId) => updateTeam({ transitions: team.transitions.filter((tr) => tr.id !== transitionId) })}
                onUpdateEdge={(transitionId, patch) =>
                  updateTeam({ transitions: team.transitions.map((tr) => (tr.id === transitionId ? { ...tr, ...patch, trigger: patch.trigger ?? tr.trigger } : tr)) })
                }
                onAddAgent={addBlankAgent}
                onAddGateway={addGateway}
                onEditGateway={(id) => setExpanded((e) => ({ ...e, [id]: true }))}
                onDeleteGateway={deleteGateway}
                onDeleteAgent={deleteAgent}
                onPositionsChange={(pos) => updateTeam({ nodePositions: { ...(team.nodePositions ?? {}), ...pos } })}
                onClearPositions={() => updateTeam({ nodePositions: undefined })}
                height={340}
                onExpand={() => setCanvasExpanded(true)}
              />
            )}
            {team.agents.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{t("team.settings.applyTemplateHint")}</div>
            )}

            {/* 网关列表（排他/并行/包容/汇聚：改名/类型/说明/删除，级联删边） */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>🧩 {t("team.settings.gateways")}（{(team.gateways ?? []).length}）</span>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("team.settings.gatewayHint")}</span>
            </div>
            {(team.gateways ?? []).length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "2px 2px" }}>{t("team.settings.gatewayEmpty")}</div>
            )}
            {(team.gateways ?? []).map((gw) => {
              const gstyle = GATEWAY_STYLE[gw.type];
              const open = !!expanded[gw.id];
              return (
                <div key={gw.id} style={styles.agentCard}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexWrap: "wrap" }}
                    onClick={() => setExpanded((e) => ({ ...e, [gw.id]: !open }))}
                  >
                    <span style={{ color: gstyle.color, fontWeight: 700, fontSize: 14, width: 18, textAlign: "center" }}>{gstyle.symbol}</span>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{gw.name}</span>
                    <span style={{ fontSize: 10.5, color: gstyle.color, border: `1px solid ${gstyle.color}`, borderRadius: 8, padding: "1px 8px" }}>{gstyle.label}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{gw.description}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{open ? "▴" : "▾"}</span>
                  </div>
                  {open && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                      <div style={styles.grid2}>
                        <Field label={t("team.settings.gatewayName")}>
                          <input value={gw.name} onChange={(e) => updateGateway(gw.id, { name: e.target.value })} style={styles.input} />
                        </Field>
                        <Field label={t("team.settings.gatewayType")}>
                          <select
                            value={gw.type}
                            onChange={(e) => updateGateway(gw.id, { type: e.target.value as GatewayType })}
                            style={styles.input}
                          >
                            {(Object.keys(GATEWAY_STYLE) as GatewayType[]).map((gt) => (
                              <option key={gt} value={gt}>{GATEWAY_STYLE[gt].symbol} {GATEWAY_STYLE[gt].label}（{gt}）</option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <Field label={t("team.settings.gatewayDescription")}>
                        <input value={gw.description ?? ""} onChange={(e) => updateGateway(gw.id, { description: e.target.value })} style={styles.input} placeholder="如：按测试结果分流" />
                      </Field>
                      <button onClick={() => deleteGateway(gw.id)} style={{ ...styles.btnDanger, alignSelf: "flex-start" }}>
                        🗑 {t("team.settings.deleteGateway")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {tab === "team" && (
          <>
            <Field label="执行模式">
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <select
                  value={team.executionMode ?? "auto"}
                  onChange={(e) => {
                    const next = e.target.value as ExecutionMode;
                    updateTeam({ executionMode: next });
                    if (next !== "custom") setTab("agents");
                  }}
                  style={styles.input}
                >
                  {EXEC_MODES.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.4 }}>
                  {EXEC_MODES.find((m) => m.id === (team.executionMode ?? "auto"))?.desc}
                </span>
                <span style={{ fontSize: 10.5, color: "var(--accent)", lineHeight: 1.4 }}>
                  {team.executionMode !== "custom" ? "仅选择「自定义」时，本设置里才显示「工作流」画布；其他模式使用内置流程，无需画图" : "当前为「自定义」：请在「工作流」标签页绘制流程"}
                </span>
              </div>
            </Field>
            <Field label={t("team.name")}>
              <input value={team.name} onChange={(e) => updateTeam({ name: e.target.value })} style={styles.input} />
            </Field>
            <div style={styles.grid2}>
              <Field label={t("team.settings.entryAgent")}>
                <select value={team.entryAgentId} onChange={(e) => updateTeam({ entryAgentId: e.target.value })} style={styles.input}>
                  {team.agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.emoji ?? "🤖"} {a.name}</option>
                  ))}
                </select>
              </Field>
              <Field label={t("team.settings.routingMode")}>
                <select value={team.defaultRoutingMode} onChange={(e) => updateTeam({ defaultRoutingMode: e.target.value as RoutingMode })} style={styles.input}>
                  {ROUTING_MODES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <span style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.4 }}>{t("team.settings.routingDesc")}</span>
              </Field>
            </div>
            <div style={styles.grid2}>
              <Field label={t("team.settings.maxHops")}>
                <input type="number" value={team.maxHops} onChange={(e) => updateTeam({ maxHops: Number(e.target.value) || 30 })} style={styles.input} />
              </Field>
              <Field label={t("team.settings.maxRework")}>
                <input type="number" value={team.maxReworkRounds} onChange={(e) => updateTeam({ maxReworkRounds: Number(e.target.value) || 3 })} style={styles.input} />
              </Field>
            </div>
            <div style={styles.grid2}>
              <Field label={t("team.settings.maxMinutes")}>
                <input type="number" value={team.maxRunMinutes} onChange={(e) => updateTeam({ maxRunMinutes: Number(e.target.value) || 60 })} style={styles.input} />
              </Field>
              <Field label={t("team.settings.contextScope")}>
                <select value={team.contextScope} onChange={(e) => updateTeam({ contextScope: e.target.value as TeamDef["contextScope"] })} style={styles.input}>
                  {CONTEXT_SCOPES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="简单任务降级（solo）">
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
                <input
                  type="checkbox"
                  checked={team.autoSolo === true}
                  onChange={(e) => updateTeam({ autoSolo: e.target.checked ? true : false })}
                  style={{ width: 16, height: 16 }}
                />
                开启后，被判定为无需拆解的简单任务只由入口角色直接完成，避免跑遍所有角色
              </label>
            </Field>
            <Field label={t("team.settings.reworkEdges")}>
              <textarea value={reworkEdgesText} onChange={(e) => setReworkEdgesText(e.target.value)} style={{ ...styles.input, minHeight: 70, fontFamily: "var(--font-mono)", fontSize: 12 }} placeholder="tester,developer&#10;qa,developer" />
            </Field>
          </>
        )}
      </div>

      {/* 校验结果 */}
      {(errors.length > 0 || warnings.length > 0) && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
          {errors.length > 0 && (
            <div style={{ fontSize: 12, color: "#e5484d" }}>
              {t("team.settings.errors")}:
              <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                {errors.map((e, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => focusIssue(e)}
                      style={styles.issueItem}
                      title={t("team.settings.issueLocate")}
                    >
                      {e.message}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div style={{ fontSize: 12, color: "#f5a623" }}>
              {t("team.settings.warnings")}:
              <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                {warnings.map((w, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => focusIssue(w)}
                      style={styles.issueItem}
                      title={t("team.settings.issueLocate")}
                    >
                      {w.message}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {errors.length === 0 && warnings.length === 0 && team && (
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--accent)" }}>✓ {t("team.settings.valid")}</div>
      )}
      {error && <div style={{ marginTop: 8, fontSize: 12, color: "#e5484d" }}>{error}</div>}

      {/* Footer */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        <button onClick={onClose} style={styles.btnSecondary}>{t("team.cancel")}</button>
        <button
          onClick={() => void handleSave()}
          disabled={saving || errors.length > 0}
          style={styles.btnPrimary}
          title={errors.length > 0 ? t("team.settings.saveBlocked", { count: errors.length }) : undefined}
        >
          {saving ? "…" : "💾"}{" "}
          {errors.length > 0
            ? t("team.settings.saveBlocked", { count: errors.length })
            : warnings.length > 0
              ? t("team.settings.saveWithWarnings", { count: warnings.length })
              : t("team.settings.save")}
        </button>
      </div>
      {/* 展开大画布弹窗（可 resize 浮层，拖动右下角调大小） */}
      {canvasExpanded && (
        <ExpandCanvasOverlay onClose={() => setCanvasExpanded(false)}>
          <WorkflowEditor
            agents={team.agents}
            transitions={team.transitions}
            entryAgentId={team.entryAgentId}
            reworkEdges={team.reworkEdges}
            gateways={team.gateways}
            nodePositions={team.nodePositions}
            onEditAgent={(id) => {
              setTab("agents");
              setExpanded((e) => ({ ...e, [id]: true }));
            }}
            onCreateEdge={(from, to) => {
              const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
              updateTeam({
                transitions: [
                  ...team.transitions,
                  { id, from, to, priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
                ],
              });
            }}
            onDeleteEdge={(transitionId) => updateTeam({ transitions: team.transitions.filter((tr) => tr.id !== transitionId) })}
            onUpdateEdge={(transitionId, patch) =>
              updateTeam({ transitions: team.transitions.map((tr) => (tr.id === transitionId ? { ...tr, ...patch, trigger: patch.trigger ?? tr.trigger } : tr)) })
            }
            onAddAgent={addBlankAgent}
            onAddGateway={addGateway}
            onEditGateway={(id) => setExpanded((e) => ({ ...e, [id]: true }))}
            onDeleteGateway={deleteGateway}
            onDeleteAgent={deleteAgent}
            onPositionsChange={(pos) => updateTeam({ nodePositions: { ...(team.nodePositions ?? {}), ...pos } })}
            onClearPositions={() => updateTeam({ nodePositions: undefined })}
            height="100%"
          />
        </ExpandCanvasOverlay>
      )}

    </DraggableResizableModal>
  );
}

/* ---------- 小组件 ---------- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)", flex: 1, minWidth: 0 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/* ---------- 样式 ---------- */

const styles: Record<string, React.CSSProperties> = {
  iconBtn: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    fontSize: 14,
    cursor: "pointer",
    padding: "4px 6px",
    borderRadius: 6,
  },
  tab: {
    background: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    padding: "6px 12px",
    fontSize: 13,
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  tabActive: {
    color: "var(--text)",
    borderBottomColor: "var(--accent)",
    fontWeight: 600,
  },
  tabCount: {
    background: "var(--bg-soft, rgba(0,0,0,0.06))",
    borderRadius: 10,
    fontSize: 10,
    padding: "1px 6px",
    color: "var(--text-muted)",
  },
  input: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "7px 10px",
    fontSize: 13,
    fontFamily: "inherit",
    background: "var(--bg)",
    color: "var(--text)",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  },
  agentCard: {
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "10px 12px",
    background: "var(--bg-soft, rgba(0,0,0,0.02))",
  },
  entryBadge: {
    background: "rgba(0,120,255,0.12)",
    color: "var(--accent)",
    fontSize: 11,
    borderRadius: 8,
    padding: "1px 8px",
  },
  condChip: {
    fontSize: 11,
    color: "var(--text-muted)",
    background: "var(--bg-soft, rgba(0,0,0,0.05))",
    borderRadius: 8,
    padding: "2px 8px",
  },
  grid2: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  },
  btnPrimary: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 13,
    cursor: "pointer",
  },
  btnSecondary: {
    background: "var(--bg-soft, rgba(0,0,0,0.05))",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "8px 14px",
    fontSize: 13,
    cursor: "pointer",
  },
  btnDanger: {
    background: "transparent",
    color: "#e5484d",
    border: "1px solid rgba(229,72,77,0.4)",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 12,
    cursor: "pointer",
  },
  viewBtn: {
    background: "transparent",
    border: "none",
    padding: "5px 12px",
    fontSize: 12,
    color: "var(--text-muted)",
    cursor: "pointer",
  },
  flowCard: {
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "10px 12px",
    background: "var(--bg-soft, rgba(0,0,0,0.02))",
  },
  issueItem: {
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    color: "inherit",
    textAlign: "left",
    textDecoration: "underline",
    textDecorationStyle: "dotted",
    fontSize: 12,
  },
};
