/**
 * TeamTemplateEditor —— 团队模板可视化编辑器。
 *  - 工作流：WorkflowEditor（react-flow）直接拖拽建边/删边/双击节点编辑角色。
 *  - 角色：列表 + 展开编辑（name/emoji/role/model/systemPrompt/tools/skillIds/thinkingLevel）。
 *  - 团队参数：入口角色/路由模式/四保险。
 *  - 保存：POST（新建）/ PATCH（更新）/api/teams/templates。
 */
"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { WorkflowEditor, GATEWAY_STYLE } from "./WorkflowEditor";
import { ExpandCanvasOverlay } from "./ExpandCanvasOverlay";
import { EmojiPicker, ToolPicker } from "./AgentFieldPickers";
import { ModelSelect } from "./ModelSelect";
import { THINKING_LEVELS } from "@/lib/team/ui-constants";
import type { UserTemplate } from "@/lib/team/templates";
import type { AgentDef, GatewayDef, GatewayType, RoutingMode } from "@/lib/team/types";

interface Props {
  template: UserTemplate;
  isNew: boolean;
  onCancel: () => void;
  onSaved: () => void;
}

const ROUTING_MODES: RoutingMode[] = ["strict", "hybrid", "autonomous"];

export function TeamTemplateEditor({ template, isNew, onCancel, onSaved }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<UserTemplate>(() => ({
    ...template,
    agents: template.agents.map((a) => ({ ...a, toolNames: [...a.toolNames] })),
    transitions: template.transitions.map((tr) => ({ ...tr })),
    gateways: template.gateways?.map((g) => ({ ...g })),
    nodePositions: template.nodePositions ? JSON.parse(JSON.stringify(template.nodePositions)) : undefined,
  }));
  const [name, setName] = useState(template.name);
  const [desc, setDesc] = useState(template.description ?? "");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateAgent = (id: string, patch: Partial<AgentDef>) => {
    setDraft((d) => ({ ...d, agents: d.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
  };

  const addEdge = (from: string, to: string) => {
    setDraft((d) => ({
      ...d,
      transitions: [
        ...d.transitions,
        { id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, from, to, priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      ],
    }));
  };

  const deleteEdge = (id: string) => {
    setDraft((d) => ({ ...d, transitions: d.transitions.filter((tr) => tr.id !== id) }));
  };

  const addAgent = (position?: { x: number; y: number }) => {
    const id = `agent-${draft.agents.length + 1}`;
    setDraft((d) => ({
      ...d,
      agents: [
        ...d.agents,
        { id, name: `角色 ${d.agents.length + 1}`, emoji: "🤖", role: "职责描述", model: "", systemPrompt: "你是新角色。", toolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"], workspace: { mode: "team" } },
      ],
      ...(position ? { nodePositions: { ...(d.nodePositions ?? {}), [id]: position } } : {}),
    }));
    setExpanded((e) => ({ ...e, [id]: true }));
  };

  const deleteAgent = (id: string) => {
    if (id === draft.entryAgentId) return;
    setDraft((d) => ({
      ...d,
      agents: d.agents.filter((a) => a.id !== id),
      transitions: d.transitions.filter((tr) => tr.from !== id && tr.to !== id),
    }));
  };

  // —— 网关操作 ——
  const addGateway = (type: GatewayType, position?: { x: number; y: number }) => {
    const base = draft.gateways ?? [];
    let n = base.length + 1;
    let id = `gw-${n}`;
    while (draft.agents.some((a) => a.id === id) || base.some((g) => g.id === id)) {
      n++;
      id = `gw-${n}`;
    }
    const gw: GatewayDef = { id, type, name: `${GATEWAY_STYLE[type].label}网关 ${n}`, description: "" };
    setDraft((d) => ({ ...d, gateways: [...base, gw], ...(position ? { nodePositions: { ...(d.nodePositions ?? {}), [id]: position } } : {}) }));
    setExpanded((e) => ({ ...e, [id]: true }));
  };

  const updateGateway = (id: string, patch: Partial<GatewayDef>) => {
    setDraft((d) => ({ ...d, gateways: (d.gateways ?? []).map((g) => (g.id === id ? { ...g, ...patch } : g)) }));
  };

  const deleteGateway = (id: string) => {
    setDraft((d) => ({
      ...d,
      gateways: (d.gateways ?? []).filter((g) => g.id !== id),
      transitions: d.transitions.filter((tr) => tr.from !== id && tr.to !== id),
    }));
  };

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        description: desc.trim(),
        agents: draft.agents,
        transitions: draft.transitions,
        gateways: draft.gateways,
        nodePositions: draft.nodePositions,
        entryAgentId: draft.entryAgentId,
        reworkEdges: draft.reworkEdges,
        defaultRoutingMode: draft.defaultRoutingMode,
        maxHops: draft.maxHops,
        maxReworkRounds: draft.maxReworkRounds,
        maxRunMinutes: draft.maxRunMinutes,
        contextScope: draft.contextScope,
      };
      const res = await fetch(isNew ? "/api/teams/templates" : `/api/teams/templates/${draft.id}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
      {error && <div style={{ fontSize: 12, color: "#e5484d" }}>{error}</div>}

      {/* 名称/描述 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("team.templates.name")}
          <input value={name} onChange={(e) => setName(e.target.value)} style={styles.input} />
        </label>
        <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("team.templates.description")}
          <input value={desc} onChange={(e) => setDesc(e.target.value)} style={styles.input} placeholder="模板用途说明" />
        </label>
      </div>

      {/* 工作流（可视化编辑） */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{t("team.templates.workflow")}</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("team.settings.workflowEditHint")}</span>
      </div>
      <WorkflowEditor
        agents={draft.agents}
        transitions={draft.transitions}
        entryAgentId={draft.entryAgentId}
        reworkEdges={draft.reworkEdges}
        gateways={draft.gateways}
        nodePositions={draft.nodePositions}
        onEditAgent={(id) => setExpanded((e) => ({ ...e, [id]: true }))}
        onCreateEdge={addEdge}
        onDeleteEdge={deleteEdge}
        onUpdateEdge={(id, patch) =>
          setDraft((d) => ({ ...d, transitions: d.transitions.map((tr) => (tr.id === id ? { ...tr, ...patch, trigger: patch.trigger ?? tr.trigger } : tr)) }))
        }
        onAddAgent={addAgent}
        onAddGateway={addGateway}
        onEditGateway={(id) => setExpanded((e) => ({ ...e, [id]: true }))}
        onDeleteGateway={deleteGateway}
        onDeleteAgent={deleteAgent}
        onPositionsChange={(pos) => setDraft((d) => ({ ...d, nodePositions: { ...(d.nodePositions ?? {}), ...pos } }))}
        onClearPositions={() => setDraft((d) => ({ ...d, nodePositions: undefined }))}
        height={320}
        onExpand={() => setCanvasExpanded(true)}
      />

      {/* 团队参数 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          {t("team.settings.entryAgent")}
          <select value={draft.entryAgentId} onChange={(e) => setDraft({ ...draft, entryAgentId: e.target.value })} style={{ ...styles.input, width: 130 }}>
            {draft.agents.map((a) => (
              <option key={a.id} value={a.id}>{a.emoji ?? "🤖"} {a.name}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          {t("team.settings.routingMode")}
          <select value={draft.defaultRoutingMode} onChange={(e) => setDraft({ ...draft, defaultRoutingMode: e.target.value as RoutingMode })} style={{ ...styles.input, width: 110 }}>
            {ROUTING_MODES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 6 }}>
          maxHops
          <input type="number" value={draft.maxHops} onChange={(e) => setDraft({ ...draft, maxHops: Number(e.target.value) || 30 })} style={{ ...styles.input, width: 70 }} />
        </label>
      </div>

      {/* 角色列表 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{t("team.settings.agentsTab")}</span>
        <button onClick={() => addAgent()} style={styles.btnSecondary}>+ {t("team.library.new")}</button>
      </div>
      {draft.agents.map((a) => {
        const open = !!expanded[a.id];
        return (
          <div key={a.id} style={styles.agentCard}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexWrap: "wrap" }} onClick={() => setExpanded((e) => ({ ...e, [a.id]: !open }))}>
              <span style={{ fontSize: 15 }}>{a.emoji ?? "🤖"}</span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{a.name}</span>
              {a.id === draft.entryAgentId && <span style={styles.entryBadge}>▶ {t("team.settings.entry")}</span>}
              <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.role}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{open ? "▴" : "▾"}</span>
            </div>
            {open && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                <div style={styles.grid2}>
                  <label style={styles.field}>{t("team.settings.agentName")}
                    <input value={a.name} onChange={(e) => updateAgent(a.id, { name: e.target.value })} style={styles.input} />
                  </label>
                  <label style={styles.field}>{t("team.settings.agentEmoji")}
                    <EmojiPicker value={a.emoji} onChange={(v) => updateAgent(a.id, { emoji: v })} />
                  </label>
                </div>
                <label style={styles.field}>{t("team.settings.agentRole")}
                  <input value={a.role} onChange={(e) => updateAgent(a.id, { role: e.target.value })} style={styles.input} />
                </label>
                <label style={styles.field}>{t("team.settings.agentModel")}
                  <ModelSelect value={a.model} onChange={(v) => updateAgent(a.id, { model: v })} />
                </label>
                <label style={styles.field}>{t("team.settings.agentPrompt")}
                  <textarea value={a.systemPrompt} onChange={(e) => updateAgent(a.id, { systemPrompt: e.target.value })} style={{ ...styles.input, minHeight: 90, fontFamily: "var(--font-mono)", fontSize: 12 }} />
                </label>
                <label style={styles.field}>{t("team.settings.agentTools")}
                  <ToolPicker value={a.toolNames} onChange={(v) => updateAgent(a.id, { toolNames: v })} />
                </label>
                <div style={styles.grid2}>
                  <label style={styles.field}>{t("team.settings.agentSkillIds")}
                    <input value={(a.skillIds ?? []).join(", ")} onChange={(e) => updateAgent(a.id, { skillIds: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} style={styles.input} />
                  </label>
                  <label style={styles.field}>{t("team.settings.agentThinking")}
                    <select value={a.thinkingLevel ?? "auto"} onChange={(e) => updateAgent(a.id, { thinkingLevel: e.target.value === "auto" ? undefined : (e.target.value as AgentDef["thinkingLevel"]) })} style={styles.input}>
                      {THINKING_LEVELS.map((lv) => (
                        <option key={lv} value={lv}>{lv}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {a.id !== draft.entryAgentId && (
                  <button onClick={() => deleteAgent(a.id)} style={{ ...styles.btnDanger, alignSelf: "flex-start" }}>
                    🗑 {t("team.settings.deleteAgent")}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* 网关列表 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>🧩 {t("team.settings.gateways")}（{(draft.gateways ?? []).length}）</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("team.settings.gatewayHint")}</span>
      </div>
      {(draft.gateways ?? []).length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "2px 2px" }}>{t("team.settings.gatewayEmpty")}</div>
      )}
      {(draft.gateways ?? []).map((gw) => {
        const s = GATEWAY_STYLE[gw.type];
        const open = !!expanded[gw.id];
        return (
          <div key={gw.id} style={styles.agentCard}>
            <div
              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexWrap: "wrap" }}
              onClick={() => setExpanded((e) => ({ ...e, [gw.id]: !open }))}
            >
              <span style={{ color: s.color, fontWeight: 700, fontSize: 14, width: 18, textAlign: "center" }}>{s.symbol}</span>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{gw.name}</span>
              <span style={{ fontSize: 10.5, color: s.color, border: `1px solid ${s.color}`, borderRadius: 8, padding: "1px 8px" }}>{s.label}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{gw.description}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{open ? "▴" : "▾"}</span>
            </div>
            {open && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                <div style={styles.grid2}>
                  <label style={styles.field}>{t("team.settings.gatewayName")}
                    <input value={gw.name} onChange={(e) => updateGateway(gw.id, { name: e.target.value })} style={styles.input} />
                  </label>
                  <label style={styles.field}>{t("team.settings.gatewayType")}
                    <select
                      value={gw.type}
                      onChange={(e) => updateGateway(gw.id, { type: e.target.value as GatewayType })}
                      style={styles.input}
                    >
                      {(Object.keys(GATEWAY_STYLE) as GatewayType[]).map((gt) => (
                        <option key={gt} value={gt}>{GATEWAY_STYLE[gt].symbol} {GATEWAY_STYLE[gt].label}（{gt}）</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label style={styles.field}>{t("team.settings.gatewayDescription")}
                  <input value={gw.description ?? ""} onChange={(e) => updateGateway(gw.id, { description: e.target.value })} style={styles.input} placeholder="如：按测试结果分流" />
                </label>
                <button onClick={() => deleteGateway(gw.id)} style={{ ...styles.btnDanger, alignSelf: "flex-start" }}>
                  🗑 {t("team.settings.deleteGateway")}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* 保存 */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4, position: "sticky", bottom: 0, background: "var(--bg)", padding: "8px 0" }}>
        <button onClick={onCancel} style={styles.btnSecondary}>{t("team.cancel")}</button>
        <button onClick={() => void save()} disabled={busy || !name.trim()} style={styles.btnPrimary}>
          {busy ? "…" : "💾"} {isNew ? t("team.templates.newSave") : t("team.settings.save")}
        </button>

      </div>
    </div>

      {/* 展开大画布弹窗（可 resize 浮层） */}
      {canvasExpanded && (
        <ExpandCanvasOverlay onClose={() => setCanvasExpanded(false)}>
          <WorkflowEditor
            agents={draft.agents}
            transitions={draft.transitions}
            entryAgentId={draft.entryAgentId}
            reworkEdges={draft.reworkEdges}
            gateways={draft.gateways}
            nodePositions={draft.nodePositions}
            onEditAgent={(id) => setExpanded((e) => ({ ...e, [id]: true }))}
            onCreateEdge={addEdge}
            onDeleteEdge={deleteEdge}
            onUpdateEdge={(id, patch) =>
              setDraft((d) => ({ ...d, transitions: d.transitions.map((tr) => (tr.id === id ? { ...tr, ...patch, trigger: patch.trigger ?? tr.trigger } : tr)) }))
            }
            onAddAgent={addAgent}
            onAddGateway={addGateway}
            onEditGateway={(id) => setExpanded((e) => ({ ...e, [id]: true }))}
            onDeleteGateway={deleteGateway}
            onDeleteAgent={deleteAgent}
            onPositionsChange={(pos) => setDraft((d) => ({ ...d, nodePositions: { ...(d.nodePositions ?? {}), ...pos } }))}
            onClearPositions={() => setDraft((d) => ({ ...d, nodePositions: undefined }))}
            height="100%"
          />
        </ExpandCanvasOverlay>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  input: {
    border: "1px solid var(--border)", borderRadius: 8, padding: "7px 10px", fontSize: 13,
    fontFamily: "inherit", background: "var(--bg)", color: "var(--text)", outline: "none", width: "100%", boxSizing: "border-box",
  },
  agentCard: { border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", background: "var(--bg-soft, rgba(0,0,0,0.02))" },
  entryBadge: { background: "rgba(0,120,255,0.12)", color: "var(--accent)", fontSize: 11, borderRadius: 8, padding: "1px 8px" },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)", flex: 1, minWidth: 0 },
  btnPrimary: { background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, cursor: "pointer" },
  btnSecondary: { background: "var(--bg-soft, rgba(0,0,0,0.05))", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer" },
  btnDanger: { background: "transparent", color: "#e5484d", border: "1px solid rgba(229,72,77,0.4)", borderRadius: 8, padding: "6px 12px", fontSize: 12, cursor: "pointer" },
};