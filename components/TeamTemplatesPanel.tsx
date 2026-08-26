/**
 * TeamTemplatesPanel —— 团队模板库（左下角设置 → 资源 → 团队模板）。
 *  - 内置模板：流程图内嵌 WorkflowEditor（react-flow 画布）直接可编辑拖动，
 *    保存改动时自动复制为「我的模板」（内置数据源保持只读）；可「以此创建项目组」。
 *  - 用户模板：卡片内直接编辑工作流 / 新建 / 可视化编辑（角色表单）/ 删除。
 *  - 模板 = 角色 + 工作流 + 团队参数的起点快照；创建项目组时套用。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { WorkflowEditor, GATEWAY_STYLE } from "./WorkflowEditor";
import { ExpandCanvasOverlay } from "./ExpandCanvasOverlay";
import { TeamTemplateEditor } from "./TeamTemplateEditor";
import type { UserTemplate } from "@/lib/team/templates";
import type { GatewayDef, GatewayType, TeamDef, Transition } from "@/lib/team/types";

interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  preview: TeamDef;
}

interface Props {
  onBack: () => void;
  /** 用指定模板创建项目组（AppShell 打开创建对话框并预选模板） */
  onCreate: (templateId: string) => void;
}

export function TeamTemplatesPanel({ onBack, onCreate }: Props) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<UserTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/teams/templates");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTemplates(data.templates ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const removeTemplate = async (id: string) => {
    try {
      const res = await fetch(`/api/teams/templates/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 内置模板 → 复制为可编辑的用户模板（isNew 模式，保存时 POST 新建）
  const duplicateBuiltin = (tmpl: TemplateInfo) => {
    setCreating(true);
    setEditing(buildDuplicateTemplate(tmpl));
  };

  // 新建：空模板（单 leader 角色 + __end__ 终边）
  const startNew = () => {
    const now = Date.now();
    setCreating(true);
    setEditing({
      id: "",
      name: "新模板",
      description: "",
      agents: [
        { id: "leader", name: "组长", emoji: "🧭", role: "项目组长", model: "", systemPrompt: "你是项目组长。", toolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"], workspace: { mode: "team" } },
      ],
      transitions: [
        { id: "t0-end", from: "leader", to: "__end__", priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true },
      ],
      entryAgentId: "leader",
      defaultRoutingMode: "hybrid",
      maxHops: 30,
      maxReworkRounds: 3,
      maxRunMinutes: 60,
      contextScope: "structured",
      createdAt: now,
      updatedAt: now,
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "14px 12px 8px", flexShrink: 0 }}>
        <button
          onClick={() => (editing ? (setEditing(null), setCreating(false)) : onBack())}
          style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: 0, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}
        >
          ← {editing ? t("team.templates.backToList") : t("team.library.back")}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15 }}>🗂️</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", flex: 1 }}>
            {editing ? (creating ? t("team.templates.newTitle") : t("team.templates.editTitle")) : t("team.templates.title")}
          </span>
          {!editing && (
            <button
              onClick={startNew}
              style={{
                background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8,
                padding: "6px 12px", fontSize: 12, cursor: "pointer",
              }}
            >
              + {t("team.templates.new")}
            </button>
          )}
        </div>
        {!editing && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.5 }}>{t("team.templates.hint")}</div>}
      </div>

      {/* Body */}
      {editing ? (
        <TeamTemplateEditor
          template={editing}
          isNew={creating}
          onCancel={() => { setEditing(null); setCreating(false); }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            void load();
          }}
        />
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
          {error && <div style={{ fontSize: 12, color: "#e5484d" }}>{error}</div>}

          {/* 用户模板 */}
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 2 }}>
            {t("team.templates.custom")}（{templates.filter((x) => !x.builtin).length}）
          </div>
          {templates.filter((x) => !x.builtin).map((tmpl) => (
            <TemplateCard
              key={tmpl.id}
              tmpl={tmpl}
              onEdit={() => {
                setCreating(false);
                setEditing(tmpl.preview as unknown as UserTemplate);
              }}
              onDelete={() => void removeTemplate(tmpl.id)}
              onCreate={() => onCreate(tmpl.id)}
              onSaved={() => void load()}
            />
          ))}
          {templates.filter((x) => !x.builtin).length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "2px 2px" }}>{t("team.templates.customEmpty")}</div>
          )}

          {/* 内置模板 */}
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 6 }}>
            {t("team.templates.builtin")}（{templates.filter((x) => x.builtin).length}）
          </div>
          {templates.filter((x) => x.builtin).map((tmpl) => (
            <TemplateCard
              key={tmpl.id}
              tmpl={tmpl}
              onCreate={() => onCreate(tmpl.id)}
              onDuplicate={() => duplicateBuiltin(tmpl)}
              onSaved={() => void load()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 内置模板 → 可编辑的用户模板数据快照（模块级纯函数，避免 React Compiler 纯度规则误报） */
function buildDuplicateTemplate(tmpl: TemplateInfo): UserTemplate {
  const p = tmpl.preview;
  const now = Date.now();
  return {
    id: "",
    name: tmpl.name,
    description: tmpl.description ?? "",
    agents: p.agents.map((a) => ({ ...a, toolNames: [...a.toolNames], ...(a.skillIds ? { skillIds: [...a.skillIds] } : {}) })),
    transitions: p.transitions.map((tr) => ({ ...tr, trigger: { ...tr.trigger, ...(tr.trigger.condition ? { condition: { ...tr.trigger.condition } } : {}) } })),
    gateways: p.gateways?.map((g) => ({ ...g })),
    nodePositions: p.nodePositions ? JSON.parse(JSON.stringify(p.nodePositions)) : undefined,
    entryAgentId: p.entryAgentId,
    reworkEdges: p.reworkEdges?.map((e) => ({ ...e })),
    defaultRoutingMode: p.defaultRoutingMode ?? "hybrid",
    maxHops: p.maxHops ?? 30,
    maxReworkRounds: p.maxReworkRounds ?? 3,
    maxRunMinutes: p.maxRunMinutes ?? 60,
    contextScope: p.contextScope ?? "structured",
    createdAt: now,
    updatedAt: now,
  };
}

function TemplateCard({
  tmpl,
  onCreate,
  onEdit,
  onDelete,
  onDuplicate,
  onSaved,
}: {
  tmpl: TemplateInfo;
  onCreate: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  /** 内置模板：复制为可编辑的用户模板 */
  onDuplicate?: () => void;
  /** 卡片内保存改动后刷新列表（内置模板保存 = 新建用户模板） */
  onSaved?: () => void;
}) {
  const { t } = useI18n();
  // 默认展开：流程图直接可见（可 ▴/▾ 折叠）
  const [open, setOpen] = useState(true);
  // 卡片内直接编辑工作流（draft 变更后才显示保存按钮）
  const [draftTransitions, setDraftTransitions] = useState<Transition[] | null>(null);
  const [draftGateways, setDraftGateways] = useState<GatewayDef[] | null>(null);
  const [draftPositions, setDraftPositions] = useState<Record<string, { x: number; y: number }> | null>(null);
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const transitions = draftTransitions ?? tmpl.preview.transitions;
  const gateways = draftGateways ?? tmpl.preview.gateways;
  const positions = draftPositions ?? tmpl.preview.nodePositions;
  const dirty =
    (draftTransitions !== null && JSON.stringify(draftTransitions) !== JSON.stringify(tmpl.preview.transitions)) ||
    (draftGateways !== null && JSON.stringify(draftGateways) !== JSON.stringify(tmpl.preview.gateways ?? [])) ||
    (draftPositions !== null && JSON.stringify(draftPositions) !== JSON.stringify(tmpl.preview.nodePositions ?? {}));

  const addEdge = (from: string, to: string) => {
    setDraftTransitions((prev) => {
      const base = prev ?? tmpl.preview.transitions;
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      return [...base, { id, from, to, priority: 0, trigger: { event: "completed", condition: { mode: "always" } }, enabled: true }];
    });
  };
  const removeEdge = (id: string) => {
    setDraftTransitions((prev) => (prev ?? tmpl.preview.transitions).filter((tr) => tr.id !== id));
  };

  // —— 卡片内网关操作 ——
  const addGateway = (type: GatewayType, position?: { x: number; y: number }) => {
    const base = draftGateways ?? tmpl.preview.gateways ?? [];
    let n = base.length + 1;
    let id = `gw-${n}`;
    while (tmpl.preview.agents.some((a) => a.id === id) || base.some((g) => g.id === id)) {
      n++;
      id = `gw-${n}`;
    }
    const gw: GatewayDef = { id, type, name: `${GATEWAY_STYLE[type].label}网关 ${n}`, description: "" };
    setDraftGateways([...base, gw]);
    if (position) setDraftPositions((prev) => ({ ...(prev ?? tmpl.preview.nodePositions ?? {}), [id]: position }));
  };
  const deleteGateway = (id: string) => {
    setDraftGateways((prev) => (prev ?? tmpl.preview.gateways ?? []).filter((g) => g.id !== id));
    setDraftTransitions((prev) => (prev ?? tmpl.preview.transitions).filter((tr) => tr.from !== id && tr.to !== id));
  };
  const updateEdge = (id: string, patch: Partial<Transition>) => {
    setDraftTransitions((prev) => (prev ?? tmpl.preview.transitions).map((tr) => (tr.id === id ? { ...tr, ...patch, trigger: patch.trigger ?? tr.trigger } : tr)));
  };

  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      const body = {
        name: tmpl.name,
        description: tmpl.description ?? "",
        agents: tmpl.preview.agents,
        transitions,
        gateways,
        nodePositions: positions,
        entryAgentId: tmpl.preview.entryAgentId,
        reworkEdges: tmpl.preview.reworkEdges,
        defaultRoutingMode: tmpl.preview.defaultRoutingMode ?? "hybrid",
        maxHops: tmpl.preview.maxHops ?? 30,
        maxReworkRounds: tmpl.preview.maxReworkRounds ?? 3,
        maxRunMinutes: tmpl.preview.maxRunMinutes ?? 60,
        contextScope: tmpl.preview.contextScope ?? "structured",
      };
      const res = await fetch(tmpl.builtin ? "/api/teams/templates" : `/api/teams/templates/${tmpl.id}`, {
        method: tmpl.builtin ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDraftTransitions(null);
      setSavedMsg(tmpl.builtin ? t("team.templates.savedAsCopy") : t("team.templates.saved"));
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, background: "var(--bg-soft, rgba(0,0,0,0.02))" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 650, fontSize: 13 }}>{tmpl.name}</span>
        {tmpl.builtin && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 8, padding: "1px 6px" }}>
            {t("team.templates.builtin")}
          </span>
        )}
        <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1, minWidth: 120 }}>{tmpl.description}</span>
        {!tmpl.builtin && onEdit && (
          <button onClick={onEdit} style={{ ...styles.btn, border: "1px solid var(--border)", color: "var(--text)" }}>
            ✏️ {t("team.templates.edit")}
          </button>
        )}
        {!tmpl.builtin && onDelete && (
          <button onClick={onDelete} style={{ ...styles.btn, border: "1px solid rgba(229,72,77,0.4)", color: "#e5484d" }}>
            🗑
          </button>
        )}
        {tmpl.builtin && onDuplicate && (
          <button onClick={onDuplicate} style={{ ...styles.btn, border: "1px solid var(--border)", color: "var(--text)" }}>
            📋 {t("team.templates.duplicate")}
          </button>
        )}
        <button onClick={onCreate} style={{ ...styles.btn, background: "var(--accent)", color: "#fff", border: "none" }}>
          👥 {t("team.templates.create")}
        </button>
        <button onClick={() => setOpen((v) => !v)} style={{ ...styles.btn, border: "none", color: "var(--text-dim)", background: "none" }}>
          {open ? "▴" : "▾"}
        </button>
      </div>
      {open && (
        <>
          <WorkflowEditor
            agents={tmpl.preview.agents}
            transitions={transitions}
            entryAgentId={tmpl.preview.entryAgentId}
            reworkEdges={tmpl.preview.reworkEdges}
            gateways={gateways as GatewayDef[] | undefined}
            nodePositions={positions}
            onEditAgent={tmpl.builtin ? onDuplicate : onEdit}
            onCreateEdge={addEdge}
            onDeleteEdge={removeEdge}
            onUpdateEdge={updateEdge}
            onAddGateway={addGateway}
            onDeleteGateway={deleteGateway}
            onPositionsChange={(pos) => setDraftPositions((prev) => ({ ...(prev ?? tmpl.preview.nodePositions ?? {}), ...pos }))}
            onClearPositions={() => setDraftPositions({})}
            height={300}
            onExpand={() => setCanvasExpanded(true)}
          />
          <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {tmpl.preview.agents.map((a) => (
              <span key={a.id} style={{ fontSize: 11, color: "var(--text-muted)", border: "1px solid var(--hairline)", borderRadius: 8, padding: "1px 8px" }}>
                {a.emoji ?? "🤖"} {a.name}
              </span>
            ))}
            {dirty && (
              <button
                onClick={() => void save()}
                disabled={busy}
                style={{ marginLeft: "auto", background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 11.5, cursor: "pointer" }}
              >
                💾 {busy ? "…" : t("team.templates.saveChanges")}
              </button>
            )}
            {savedMsg && <span style={{ fontSize: 11, color: "#30a46c" }}>{savedMsg}</span>}
            {error && <span style={{ fontSize: 11, color: "#e5484d" }}>{error}</span>}
          </div>
        </>
      )}

      {/* 展开大画布（可 resize 浮层） */}
      {canvasExpanded && (
        <ExpandCanvasOverlay onClose={() => setCanvasExpanded(false)}>
          <WorkflowEditor
            agents={tmpl.preview.agents}
            transitions={transitions}
            entryAgentId={tmpl.preview.entryAgentId}
            reworkEdges={tmpl.preview.reworkEdges}
            gateways={gateways as GatewayDef[] | undefined}
            nodePositions={positions}
            onEditAgent={tmpl.builtin ? onDuplicate : onEdit}
            onCreateEdge={addEdge}
            onDeleteEdge={removeEdge}
            onUpdateEdge={updateEdge}
            onAddGateway={addGateway}
            onDeleteGateway={deleteGateway}
            onPositionsChange={(pos) => setDraftPositions((prev) => ({ ...(prev ?? tmpl.preview.nodePositions ?? {}), ...pos }))}
            onClearPositions={() => setDraftPositions({})}
            height="100%"
          />
        </ExpandCanvasOverlay>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  btn: { borderRadius: 8, padding: "5px 10px", fontSize: 11.5, cursor: "pointer", whiteSpace: "nowrap" },
};
