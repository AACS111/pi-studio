/**
 * AgentLibraryPanel —— 全局角色库管理（左下角设置 → 角色库）。
 * 角色库是"基础角色模板池"：在全局预配置基础角色，进入项目组后
 * 通过 TeamSettings「从角色库添加」把它们拉进具体项目组（可再按组改）。
 *
 *  - 内置角色：可编辑（保存为覆盖项，可恢复默认）。
 *  - 自建角色：新建 / 编辑 / 删除（POST / PATCH / DELETE /api/teams/agents/library）。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ModelSelect } from "./ModelSelect";
import { EmojiPicker, ToolPicker } from "./AgentFieldPickers";
import type { AgentLibraryItem } from "@/lib/team/types";

interface Props {
  onBack: () => void;
}

interface FormState {
  id?: string;
  name: string;
  emoji: string;
  role: string;
  model: string;
  systemPrompt: string;
  toolNames: string;
  skillIds: string;
}

const EMPTY_FORM: FormState = {
  id: undefined,
  name: "",
  emoji: "🤖",
  role: "",
  model: "",
  systemPrompt: "",
  toolNames: "read, bash, edit, write, grep, find, ls",
  skillIds: "",
};

export function AgentLibraryPanel({ onBack }: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<AgentLibraryItem[]>([]);
  const [overriddenIds, setOverriddenIds] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/teams/agents/library");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setItems(data.items ?? []);
      setOverriddenIds(new Set(data.overriddenIds ?? []));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const builtin = items.filter((i) => i.builtin);
  const userItems = items.filter((i) => !i.builtin);

  const startNew = () => setEditing({ ...EMPTY_FORM });

  const startEdit = (item: AgentLibraryItem) =>
    setEditing({
      id: item.id,
      name: item.name,
      emoji: item.emoji ?? "",
      role: item.role,
      model: item.model ?? "",
      systemPrompt: item.systemPrompt,
      toolNames: item.toolNames.join(", "),
      skillIds: (item.skillIds ?? []).join(", "),
    });

  const saveForm = async () => {
    if (!editing || busy) return;
    if (!editing.name.trim() || !editing.role.trim() || !editing.systemPrompt.trim()) {
      setError(t("team.library.required"));
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // 有 id（自建/内置覆盖）→ PATCH（路由已支持：用户库有则更新，内置则创建覆盖项）；无 id → POST 新建
      const isNew = !editing.id;
      const body = {
        name: editing.name.trim(),
        emoji: editing.emoji.trim() || undefined,
        role: editing.role.trim(),
        model: editing.model.trim(),
        systemPrompt: editing.systemPrompt,
        toolNames: editing.toolNames.split(",").map((s) => s.trim()).filter(Boolean),
        skillIds: editing.skillIds.split(",").map((s) => s.trim()).filter(Boolean) || undefined,
      };
      const res = await fetch(isNew ? "/api/teams/agents/library" : `/api/teams/agents/library/${editing.id}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSaved(true);
      setEditing(null);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/teams/agents/library/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const resetBuiltin = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/teams/agents/library/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "14px 12px 8px", flexShrink: 0 }}>
        <button
          onClick={onBack}
          style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: 0, marginBottom: 6, display: "flex", alignItems: "center", gap: 4 }}
        >
          ← {t("team.library.back")}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15 }}>👥</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", flex: 1 }}>{t("team.library.title")}</span>
          <button onClick={startNew} style={styles.btnPrimary}>+ {t("team.library.new")}</button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.5 }}>{t("team.library.hint")}</div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
        {saved && <div style={{ fontSize: 12, color: "var(--accent)" }}>✓ {t("team.library.saved")}</div>}
        {error && <div style={{ fontSize: 12, color: "#e5484d" }}>{error}</div>}

        {/* 新建/编辑表单 */}
        {editing && (
          <div style={styles.formCard}>
            <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>
              {editing.id ? `✏️ ${t("team.library.edit")}: ${editing.name}` : `✨ ${t("team.library.new")}`}
            </div>
            <div style={styles.grid2}>
              <Field label={t("team.settings.agentName")}>
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={styles.input} />
              </Field>
              <Field label={t("team.settings.agentEmoji")}>
                <EmojiPicker value={editing.emoji} onChange={(v) => setEditing({ ...editing, emoji: v })} placeholder={t("team.settings.agentEmoji")} />
              </Field>
            </div>
            <Field label={t("team.settings.agentRole")}>
              <input value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })} style={styles.input} />
            </Field>
            <Field label={t("team.settings.agentModel")}>
              <ModelSelect value={editing.model} onChange={(v) => setEditing({ ...editing, model: v })} style={styles.input} />
            </Field>
            <Field label={t("team.settings.agentPrompt")}>
              <textarea value={editing.systemPrompt} onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })} style={{ ...styles.input, minHeight: 110, fontFamily: "var(--font-mono)", fontSize: 12 }} />
            </Field>
            <div style={styles.grid2}>
              <Field label={t("team.settings.agentTools")}>
                <ToolPicker
                  value={editing.toolNames.split(",").map((s) => s.trim()).filter(Boolean)}
                  onChange={(v) => setEditing({ ...editing, toolNames: v.join(", ") })}
                  placeholder={t("team.settings.agentTools")}
                />
              </Field>
              <Field label={t("team.settings.agentSkillIds")}>
                <input value={editing.skillIds} onChange={(e) => setEditing({ ...editing, skillIds: e.target.value })} style={styles.input} />
              </Field>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
              <button onClick={() => setEditing(null)} style={styles.btnSecondary}>{t("team.cancel")}</button>
              <button onClick={() => void saveForm()} disabled={busy} style={styles.btnPrimary}>
                {busy ? "…" : "💾"} {t("team.settings.save")}
              </button>
            </div>
          </div>
        )}

        {/* 自建角色 */}
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 4 }}>
          {t("team.library.custom")}（{userItems.length}）
        </div>
        {userItems.length === 0 && !editing && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "4px 2px" }}>{t("team.library.customEmpty")}</div>
        )}
        {userItems.map((item) => (
          <LibraryCard key={item.id} item={item} onEdit={() => startEdit(item)} onDelete={() => void removeItem(item.id)} />
        ))}

        {/* 内置角色（可编辑：保存为覆盖，可恢复默认） */}
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 8 }}>
          {t("team.library.builtin")}（{builtin.length}）
        </div>
        {builtin.map((item) => (
          <LibraryCard
            key={item.id}
            item={item}
            overridden={overriddenIds.has(item.id)}
            onEdit={() => startEdit(item)}
            onReset={() => void resetBuiltin(item.id)}
            resetLabel={t("team.library.reset")}
          />
        ))}
      </div>
    </div>
  );
}

/** 角色卡片：头部（emoji+name+role）+ 可展开详情（systemPrompt/工具） */
function LibraryCard({
  item,
  onEdit,
  onDelete,
  onReset,
  overridden,
  resetLabel,
}: {
  item: AgentLibraryItem;
  onEdit?: () => void;
  onDelete?: () => void;
  onReset?: () => void;
  overridden?: boolean;
  resetLabel?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div style={styles.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexWrap: "wrap" }} onClick={() => setOpen((v) => !v)}>
        <span style={{ fontSize: 15 }}>{item.emoji ?? "🤖"}</span>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{item.name}</span>
        {item.builtin && <span style={styles.builtinBadge}>{t("team.library.builtin")}</span>}
        {overridden && <span style={styles.overrideBadge}>{t("team.library.overridden")}</span>}
        <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.role}
        </span>
        {onEdit && (
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} style={styles.iconBtn} aria-label="edit">✏️</button>
        )}
        {onReset && overridden && (
          <button onClick={(e) => { e.stopPropagation(); onReset(); }} style={styles.iconBtn} aria-label={resetLabel} title={resetLabel}>↺</button>
        )}
        {onDelete && (
          <button onClick={(e) => { e.stopPropagation(); onDelete(); }} style={styles.iconBtn} aria-label="delete">🗑</button>
        )}
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{open ? "▴" : "▾"}</span>
      </div>
      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {t("team.settings.agentModel")}: {item.model || t("team.settings.defaultModel")}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto", border: "1px solid var(--hairline)", borderRadius: 8, padding: 8 }}>
            {item.systemPrompt}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            tools: {item.toolNames.join(", ")}
            {item.skillIds?.length ? ` · skills: ${item.skillIds.join(", ")}` : ""}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-muted)", flex: 1, minWidth: 0 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

const styles: Record<string, React.CSSProperties> = {
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
  card: {
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "9px 11px",
    background: "var(--bg-soft, rgba(0,0,0,0.02))",
  },
  formCard: {
    border: "1px solid var(--accent)",
    borderRadius: 10,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  builtinBadge: {
    fontSize: 10,
    color: "var(--text-dim)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "1px 6px",
  },
  overrideBadge: {
    fontSize: 10,
    color: "var(--accent)",
    background: "rgba(0,120,255,0.10)",
    borderRadius: 8,
    padding: "1px 6px",
  },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    fontSize: 13,
    cursor: "pointer",
    padding: "2px 4px",
    borderRadius: 6,
  },
  btnPrimary: {
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 12,
    cursor: "pointer",
  },
  btnSecondary: {
    background: "var(--bg-soft, rgba(0,0,0,0.05))",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 12,
    cursor: "pointer",
  },
};
