/**
 * WorkflowEditor —— 项目组工作流可视化编辑器（基于 @xyflow/react，n8n/Dify 式画布交互）。
 *  - 左侧紧凑 Palette：点击添加角色 / 网关（排他× 并行＋ 包容○ 汇聚＝）+ ⟳ 布局。
 *  - 连线：拖节点右侧圆点松手即建边（默认 always，双击边就近编辑条件）。
 *  - 双击边 → 浮层编辑面板：事件 / 条件模式 / 关键词 / llm 条件 / 优先级 / 启用 / 删除。
 *  - Delete / Backspace：删除选中节点（角色/网关，级联删边）或边；⏹ __end__ 不可删。
 *  - 布局持久化：拖动位置经 onPositionsChange 存 nodePositions；「⟳ 布局」一键重排。
 *  - 画布高度可调（height，默认 360）；右上角「⛶ 展开 / ⤡ 收起」切到全屏大画布。
 *  - 节点 = Agent（emoji + 名称 + 职责）+ 网关（BPMN 菱形）+ ⏹ __end__。
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  applyEdgeChanges,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AgentDef, Condition, ConditionMode, GatewayDef, GatewayType, Transition, TransitionEvent } from "@/lib/team/types";

const NODE_W = 168;
const NODE_H = 54;
const COL_GAP = 80;
const ROW_GAP = 24;
const PAD = 16;

interface FlowPos {
  x: number;
  y: number;
}

/** 网关外观：符号 + 强调色 */
export const GATEWAY_STYLE: Record<GatewayType, { symbol: string; label: string; color: string }> = {
  exclusive: { symbol: "×", label: "排他", color: "#3b82f6" },
  parallel: { symbol: "＋", label: "并行", color: "#22c55e" },
  inclusive: { symbol: "○", label: "包容", color: "#f59e0b" },
  merge: { symbol: "＝", label: "汇聚", color: "#a855f7" },
};

/** BFS 分层布局（从入口出发；不可达节点放最后一列；__end__ 终列） */
function flowLayout(agents: AgentDef[], transitions: Transition[], entryAgentId: string, gateways: GatewayDef[] = []): Map<string, FlowPos> {
  const pos = new Map<string, FlowPos>();
  const nodeIds = new Set<string>([...agents.map((a) => a.id), ...gateways.map((g) => g.id)]);
  const layer = new Map<string, number>();
  const queue: string[] = [];
  if (nodeIds.has(entryAgentId)) {
    layer.set(entryAgentId, 0);
    queue.push(entryAgentId);
  }
  const visited = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const l = layer.get(cur) ?? 0;
    for (const tr of transitions) {
      if (tr.from !== cur || tr.enabled === false) continue;
      const to = tr.to;
      if (to === "__end__" || nodeIds.has(to)) {
        if (!layer.has(to) || layer.get(to)! > l + 1) {
          layer.set(to, l + 1);
          if (to !== "__end__") queue.push(to);
        }
      }
    }
  }
  let maxLayer = -1;
  for (const l of layer.values()) if (l > maxLayer) maxLayer = l;

  const hasEndRef = transitions.some((tr) => tr.to === "__end__");
  const nodeLayer = new Map<string, number>();
  for (const id of nodeIds) nodeLayer.set(id, layer.get(id) ?? maxLayer + 1);
  if (hasEndRef) nodeLayer.set("__end__", maxLayer + 1);

  const byLayer = new Map<number, string[]>();
  const lastCol: string[] = [];
  const lastLayerNum = maxLayer + 1;
  for (const id of nodeIds) {
    const l = nodeLayer.get(id)!;
    if (l === lastLayerNum && !layer.has(id)) lastCol.push(id);
    else {
      const arr = byLayer.get(l) ?? [];
      arr.push(id);
      byLayer.set(l, arr);
    }
  }
  if (hasEndRef) lastCol.push("__end__");
  if (lastCol.length) byLayer.set(lastLayerNum, lastCol);

  for (const [l, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, row) => {
      pos.set(id, { x: PAD + l * (NODE_W + COL_GAP), y: PAD + row * (NODE_H + ROW_GAP) });
    });
  }
  return pos;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function edgeLabel(tr: Transition): string {
  const cond = tr.trigger.condition;
  const parts: string[] = [];
  if (tr.trigger.event !== "completed") parts.push(tr.trigger.event);
  if (cond?.mode === "keyword") parts.push(`🔑 ${(cond.keywords ?? []).join("/")}`);
  else if (cond?.mode === "llm") parts.push("🤖 llm");
  else if (cond?.mode === "always") parts.push("∞");
  return truncate(`p${tr.priority} ${parts.join(" ") || "always"}`, 30);
}

function AgentNode({ data }: NodeProps) {
  const a = data as { id: string; emoji: string; name: string; role: string; isEntry: boolean; isEnd: boolean };
  if (a.isEnd) {
    return (
      <div
        style={{
          width: NODE_W, height: NODE_H, borderRadius: 12, border: "1.5px dashed var(--text-dim)",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12,
          color: "var(--text-dim)", background: "var(--bg-soft, rgba(0,0,0,0.03))", boxSizing: "border-box",
        }}
      >
        <Handle type="target" position={Position.Left} style={{ background: "var(--text-dim)" }} />
        ⏹ __end__
      </div>
    );
  }
  return (
    <div
      style={{
        width: NODE_W, height: NODE_H, borderRadius: 12, boxSizing: "border-box", padding: "6px 10px",
        border: `1.5px solid ${a.isEntry ? "var(--accent)" : "var(--border)"}`,
        background: a.isEntry ? "rgba(0,120,255,0.10)" : "var(--bg, #fff)",
        display: "flex", flexDirection: "column", justifyContent: "center", gap: 2,
        boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "var(--text-dim)" }} />
      <div style={{ fontSize: 13, fontWeight: 650, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 4 }}>
        <span>{a.emoji}</span>
        <span>{truncate(a.name, 12)}{a.isEntry ? " ▶" : ""}</span>
      </div>
      <div style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {truncate(a.role, 20)}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: "var(--accent)" }} />
    </div>
  );
}

/** 网关节点：BPMN 菱形 + 类型符号 */
function GatewayNode({ data }: NodeProps) {
  const g = data as { id: string; name: string; type: GatewayType };
  const s = GATEWAY_STYLE[g.type] ?? GATEWAY_STYLE.exclusive;
  return (
    <div
      style={{
        width: NODE_W, height: NODE_H, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 1, boxSizing: "border-box",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: s.color }} />
      <svg width={32} height={32} viewBox="0 0 34 34" style={{ flexShrink: 0 }}>
        <rect x={3} y={3} width={28} height={28} rx={5} transform="rotate(45 17 17)" fill="rgba(255,255,255,0.92)" stroke={s.color} strokeWidth={1.6} />
        <text x={17} y={21.5} textAnchor="middle" fontSize={16} fontWeight={700} fill={s.color}>{s.symbol}</text>
      </svg>
      <div style={{ fontSize: 11, fontWeight: 650, color: "var(--text)", lineHeight: 1.1 }}>{truncate(g.name, 12)}</div>
      <div style={{ fontSize: 9, color: s.color, lineHeight: 1.1 }}>{s.label}</div>
      <Handle type="source" position={Position.Right} style={{ background: s.color }} />
    </div>
  );
}

const nodeTypes = { agent: AgentNode, gateway: GatewayNode };

const TRANSITION_EVENTS: TransitionEvent[] = ["completed", "failed", "timeout", "handoff", "any"];
const CONDITION_MODES: ConditionMode[] = ["always", "keyword", "llm"];

interface Props {
  agents: AgentDef[];
  transitions: Transition[];
  entryAgentId: string;
  reworkEdges?: { from: string; to: string }[];
  gateways?: GatewayDef[];
  /** 画布节点位置（拖动持久化；缺省自动布局） */
  nodePositions?: Record<string, { x: number; y: number }>;
  onEditAgent?: (id: string) => void;
  onCreateEdge?: (from: string, to: string) => void;
  onSelectEdge?: (transitionId: string) => void;
  onDeleteEdge?: (transitionId: string) => void;
  /** 双击边浮层编辑：条件/优先级等就地修改 */
  onUpdateEdge?: (transitionId: string, patch: Partial<Transition>) => void;
  /** 添加角色 / 网关（position = 画布内落点，父级存入 nodePositions） */
  onAddAgent?: (position?: { x: number; y: number }) => void;
  onAddGateway?: (type: GatewayType, position?: { x: number; y: number }) => void;
  onEditGateway?: (id: string) => void;
  onDeleteGateway?: (id: string) => void;
  onDeleteAgent?: (id: string) => void;
  /** 节点拖动结束 → 持久化位置 */
  onPositionsChange?: (pos: Record<string, { x: number; y: number }>) => void;
  /** 清除自定义位置（自动布局） */
  onClearPositions?: () => void;
  /** 画布高度（默认 360；展开弹窗用 "100%"） */
  height?: number | string;
  /** 顶栏右上角：展开 / 收起画布 */
  onExpand?: () => void;
  onCollapse?: () => void;
}

export function WorkflowEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({
  agents, transitions, entryAgentId, reworkEdges, gateways, nodePositions,
  onEditAgent, onCreateEdge, onSelectEdge, onDeleteEdge, onUpdateEdge,
  onAddAgent, onAddGateway, onEditGateway, onDeleteGateway, onDeleteAgent,
  onPositionsChange, onClearPositions, height, onExpand, onCollapse,
}: Props) {
  const { screenToFlowPosition } = useReactFlow();
  const reworkSet = useMemo(() => new Set((reworkEdges ?? []).map((e) => `${e.from}->${e.to}`)), [reworkEdges]);
  const gwList = useMemo(() => gateways ?? [], [gateways]);
  const savedPos = useMemo(() => nodePositions ?? {}, [nodePositions]);

  // 初始布局（BFS；nodePositions 覆盖）
  const initialPos = useMemo(() => flowLayout(agents, transitions, entryAgentId, gwList), [agents, transitions, entryAgentId, gwList]);
  const nodeInitPos = useCallback(
    (id: string) => savedPos[id] ?? initialPos.get(id) ?? { x: PAD, y: PAD },
    [savedPos, initialPos],
  );

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // 构建节点：增量同步（保留已有位置；新增用 nodeInitPos；数据更新同步 data）
  useEffect(() => {
    setNodes((prev) => {
      const aliveIds = new Set<string>([...agents.map((a) => a.id), ...gwList.map((g) => g.id)]);
      if (transitions.some((tr) => tr.to === "__end__")) aliveIds.add("__end__");
      const next = prev.filter((n) => aliveIds.has(n.id));
      const agentById = new Map(agents.map((a) => [a.id, a]));
      const gwById = new Map(gwList.map((g) => [g.id, g]));
      // 新增节点
      for (const a of agents) {
        if (!next.some((n) => n.id === a.id)) {
          next.push({ id: a.id, type: "agent", position: nodeInitPos(a.id), data: { id: a.id, emoji: a.emoji ?? "🤖", name: a.name, role: a.role, isEntry: a.id === entryAgentId } });
        }
      }
      for (const g of gwList) {
        if (!next.some((n) => n.id === g.id)) {
          next.push({ id: g.id, type: "gateway", position: nodeInitPos(g.id), data: { id: g.id, name: g.name, type: g.type } });
        }
      }
      if (transitions.some((tr) => tr.to === "__end__") && !next.some((n) => n.id === "__end__")) {
        next.push({ id: "__end__", type: "agent", position: nodeInitPos("__end__"), data: { id: "__end__", isEnd: true } });
      }
      // 同步 data（名称/emoji/入口变化）
      return next.map((n) => {
        if (n.id === "__end__") return n;
        const a = agentById.get(n.id);
        if (a) return { ...n, data: { id: a.id, emoji: a.emoji ?? "🤖", name: a.name, role: a.role, isEntry: a.id === entryAgentId } };
        const g = gwById.get(n.id);
        if (g) return { ...n, data: { id: g.id, name: g.name, type: g.type } };
        return n;
      });
    });
  }, [agents, gwList, transitions, entryAgentId, nodeInitPos]);

  // 边：本地 state（transitions 变化时重建）
  useEffect(() => {
    setEdges(
      transitions.map((tr) => {
        const pair = `${tr.from}->${tr.to}`;
        const rework = reworkSet.has(pair);
        return {
          id: tr.id,
          source: tr.from,
          target: tr.to,
          label: edgeLabel(tr),
          labelStyle: { fontSize: 9.5, fill: tr.enabled === false ? "var(--text-dim)" : rework ? "#e5484d" : "var(--text-dim)", opacity: tr.enabled === false ? 0.5 : 1 },
          labelBgStyle: { fill: "var(--bg)", fillOpacity: 0.9 },
          style: {
            stroke: rework ? "#e5484d" : "var(--text-dim)",
            strokeWidth: rework ? 1.8 : 1.2,
            strokeDasharray: tr.enabled === false ? "5 4" : undefined,
            opacity: tr.enabled === false ? 0.35 : rework ? 0.85 : 0.6,
          },
          data: { transitionId: tr.id },
          type: "default",
        };
      }),
    );
  }, [transitions, reworkSet]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  // 节点拖动结束：持久化位置
  const handleNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (node.id === "__end__") return;
      onPositionsChange?.({ [node.id]: node.position });
    },
    [onPositionsChange],
  );

  // Delete / Backspace 删除
  const handleNodesDelete = useCallback(
    (deleted: Node[]) => {
      let removedEnd = false;
      for (const n of deleted) {
        if (n.id === "__end__") {
          removedEnd = true;
          continue;
        }
        if (n.type === "gateway") onDeleteGateway?.(n.id);
        else onDeleteAgent?.(n.id);
      }
      if (removedEnd) {
        // __end__ 不可删：本地补回
        setNodes((prev) => (prev.some((n) => n.id === "__end__") ? prev : [...prev, { id: "__end__", type: "agent", position: nodeInitPos("__end__"), data: { id: "__end__", isEnd: true } }]));
      }
    },
    [onDeleteAgent, onDeleteGateway, nodeInitPos],
  );
  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const e of deleted) onDeleteEdge?.(e.id);
    },
    [onDeleteEdge],
  );

  const handleConnect = useCallback(
    (c: Connection) => {
      if (c.source && c.target && c.source !== c.target) onCreateEdge?.(c.source, c.target);
    },
    [onCreateEdge],
  );

  const handleEdgeClick = useCallback((_: unknown, edge: Edge) => onSelectEdge?.(edge.id), [onSelectEdge]);
  const handleEdgeDoubleClick = useCallback((_: unknown, edge: Edge) => setEditingEdgeId(edge.id), []);
  const handleNodeDoubleClick = useCallback(
    (_: unknown, node: Node) => {
      const id = node.id;
      if (id === "__end__") return;
      if (node.type === "gateway") {
        onEditGateway?.(id);
        return;
      }
      onEditAgent?.(id);
    },
    [onEditAgent, onEditGateway],
  );

  // Palette 点击添加：落点在画布中心
  const addAtCenter = () => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const rect = el.getBoundingClientRect();
    return screenToFlowPosition({ x: rect.left + rect.width * 0.45, y: rect.top + rect.height * 0.4 });
  };

  // 自动布局
  const autoLayout = () => {
    onClearPositions?.();
    setNodes((prev) => prev.map((n) => ({ ...n, position: initialPos.get(n.id) ?? n.position })));
  };

  const editingTr = editingEdgeId ? transitions.find((tr) => tr.id === editingEdgeId) : undefined;

  return (
    <div
      ref={canvasRef}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        // 字符串高度（"100%"）时撑满展开层；数值高度时由内容(auto)撑起
        height: typeof height === "string" ? "100%" : undefined,
        minHeight: typeof height === "string" ? 0 : undefined,
      }}
    >
      {/* 顶栏：交互提示 + 展开/收起 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>拖节点移动 · 拖右侧圆点连线 · 双击边/节点编辑 · Delete 删除</span>
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
          {onCollapse && (
            <button onClick={onCollapse} title="退出全屏" style={toolbarBtn}>
              ✕ 退出全屏
            </button>
          )}
          {onExpand && !onCollapse && (
            <button onClick={onExpand} title="全屏放大画布" style={{ ...toolbarBtn, color: "var(--accent)" }}>
              ⛶ 全屏
            </button>
          )}
        </span>
      </div>

      <div
        style={{
          // 字符串高度（"100%"）→ flex 撑满顶层剩余空间；数值 → 固定高度
          flex: typeof height === "string" ? 1 : undefined,
          minHeight: typeof height === "string" ? 0 : undefined,
          height: typeof height === "string" ? undefined : (height ?? 360),
          position: "relative",
          border: "1px solid var(--hairline)",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {/* Palette：左侧紧凑添加面板（放在画布容器内，避免压住顶栏提示文字） */}
        {(onAddAgent || onAddGateway) && (
          <div
            style={{
              position: "absolute", left: 4, top: 4, zIndex: 10, width: 76,
              background: "var(--bg)", border: "1px solid var(--hairline)", borderRadius: 8,
              padding: 4, display: "flex", flexDirection: "column", gap: 3,
              boxShadow: "0 3px 10px rgba(0,0,0,0.08)", fontSize: 10,
            }}
          >
            <span style={{ fontSize: 8, color: "var(--text-dim)", fontWeight: 600, letterSpacing: "0.03em", paddingLeft: 2, marginBottom: 1 }}>＋ 节点</span>
            {onAddAgent && (
              <button onClick={() => onAddAgent(addAtCenter())} style={paletteBtn} title="添加角色">
                🤖 角色
              </button>
            )}
            {(Object.keys(GATEWAY_STYLE) as GatewayType[]).map((gt) => {
              const s = GATEWAY_STYLE[gt];
              return (
                <button key={gt} onClick={() => onAddGateway?.(gt, addAtCenter())} style={{ ...paletteBtn, borderColor: s.color, color: s.color }} title={`添加${s.label}网关`}>
                  <span style={{ fontWeight: 700 }}>{s.symbol}</span> {s.label}
                </button>
              );
            })}
            {onClearPositions && (
              <button onClick={autoLayout} style={{ ...paletteBtn, borderColor: "var(--hairline)", color: "var(--text-dim)" }} title="重新按入口 BFS 排布">
                ⟳ 布局
              </button>
            )}
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodeDragStop={handleNodeDragStop}
          onEdgeClick={handleEdgeClick}
          onEdgeDoubleClick={handleEdgeDoubleClick}
          onNodesDelete={handleNodesDelete}
          onEdgesDelete={handleEdgesDelete}
          deleteKeyCode={["Delete", "Backspace"]}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          nodesDraggable
          nodesConnectable
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* 双击边 → 就近编辑面板 */}
      {editingTr && onUpdateEdge && (
        <EdgeEditPanel
          tr={editingTr}
          onPatch={(patch) => onUpdateEdge(editingTr.id, patch)}
          onDelete={() => {
            onDeleteEdge?.(editingTr.id);
            setEditingEdgeId(null);
          }}
          onClose={() => setEditingEdgeId(null)}
        />
      )}
    </div>
  );
}

const paletteBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3,
  background: "var(--bg-soft, rgba(0,0,0,0.04))", border: "1px solid var(--hairline)",
  borderRadius: 6, padding: "2px 4px", fontSize: 9.5, cursor: "pointer", width: "100%",
  color: "var(--text)",
};

const toolbarBtn: React.CSSProperties = {
  background: "transparent", border: "1px solid var(--hairline)", borderRadius: 7,
  padding: "2px 9px", fontSize: 10, cursor: "pointer", color: "var(--text-dim)", whiteSpace: "nowrap",
};

/** 边条件就地编辑浮层 */
function EdgeEditPanel({
  tr,
  onPatch,
  onDelete,
  onClose,
}: {
  tr: Transition;
  onPatch: (patch: Partial<Transition>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const cond = tr.trigger.condition;
  const setCond = (patch: Partial<Condition>) =>
    onPatch({ trigger: { ...tr.trigger, condition: { ...(cond ?? { mode: "always" as const }), ...patch } } });

  return (
    <div
      style={{
        position: "absolute", top: 8, right: 8, zIndex: 20, width: 240,
        background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
        padding: 10, boxShadow: "0 8px 28px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>✏️ 边条件</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}>✕</button>
      </div>

      <div style={fieldRow}>
        <label style={fieldLabel}>事件</label>
        <select
          value={tr.trigger.event}
          onChange={(e) => onPatch({ trigger: { ...tr.trigger, event: e.target.value as TransitionEvent } })}
          style={input}
        >
          {TRANSITION_EVENTS.map((ev) => (
            <option key={ev} value={ev}>{ev}</option>
          ))}
        </select>
      </div>

      <div style={fieldRow}>
        <label style={fieldLabel}>条件</label>
        <select
          value={cond?.mode ?? "always"}
          onChange={(e) => setCond({ mode: e.target.value as ConditionMode })}
          style={input}
        >
          {CONDITION_MODES.map((m) => (
            <option key={m} value={m}>{m === "always" ? "∞ always（无条件）" : m === "keyword" ? "🔑 关键词" : "🤖 llm 判定"}</option>
          ))}
        </select>
      </div>

      {cond?.mode === "keyword" && (
        <div style={fieldRow}>
          <label style={fieldLabel}>关键词</label>
          <input
            value={(cond.keywords ?? []).join(", ")}
            onChange={(e) => setCond({ keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            placeholder="问题, 失败, bug"
            style={input}
          />
        </div>
      )}
      {cond?.mode === "llm" && (
        <div style={fieldRow}>
          <label style={fieldLabel}>判定规则</label>
          <textarea
            value={cond.conditionText ?? ""}
            onChange={(e) => setCond({ conditionText: e.target.value })}
            placeholder="自然语言描述触发条件"
            style={{ ...input, minHeight: 56, fontFamily: "var(--font-mono)", fontSize: 11 }}
          />
        </div>
      )}

      <div style={fieldRow}>
        <label style={fieldLabel}>优先级</label>
        <input
          type="number"
          value={tr.priority}
          onChange={(e) => onPatch({ priority: Number(e.target.value) || 0 })}
          style={{ ...input, width: 70 }}
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--text-muted)", marginLeft: 8 }}>
          <input
            type="checkbox"
            checked={tr.enabled !== false}
            onChange={(e) => onPatch({ enabled: e.target.checked })}
            style={{ width: 15, height: 15 }}
          />
          启用
        </label>
      </div>

      <div style={fieldRow}>
        <label style={fieldLabel}>裁决</label>
        <select
          value={tr.verdictGuard ?? ""}
          onChange={(e) => onPatch({ verdictGuard: e.target.value === "" ? undefined : (e.target.value as "pass" | "fail") })}
          style={input}
        >
          <option value="">无（默认）</option>
          <option value="pass">pass（通过）</option>
          <option value="fail">fail（返工）</option>
        </select>
      </div>

      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--text-muted)" }}>
        <input
          type="checkbox"
          checked={tr.approval === true}
          onChange={(e) => onPatch({ approval: e.target.checked ? true : undefined })}
          style={{ width: 14, height: 14 }}
        />
        🔒 需人工审批（命中此边时暂停等你确认）
      </label>

      <button onClick={onDelete} style={{ ...paletteBtn, borderColor: "rgba(229,72,77,0.4)", color: "#e5484d" }}>
        🗑 删除此边
      </button>
    </div>
  );
}

const input: React.CSSProperties = {
  border: "1px solid var(--border)", borderRadius: 7, padding: "5px 8px", fontSize: 12,
  fontFamily: "inherit", background: "var(--bg)", color: "var(--text)", outline: "none", flex: 1, minWidth: 0,
};
const fieldRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const fieldLabel: React.CSSProperties = { fontSize: 11.5, color: "var(--text-muted)", width: 52, flexShrink: 0 };