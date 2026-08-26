/**
 * ModelSelect —— 模型库下拉选择（供 TeamSettings / AgentLibraryPanel 复用）。
 * 数据源：GET /api/models（modelList: [{id, name, provider}]）。
 * 值格式：空串 = 跟随全局默认；否则 "provider/modelId"（与 executor.parseAgentModel 一致）。
 * 若当前值不在模型库中（如旧数据/自定义 id），自动追加一项保持显示。
 */
"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

interface ModelOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  style?: React.CSSProperties;
  /** 自定义 cwd（默认省略，服务端回退 process.cwd） */
  cwd?: string;
}

export function ModelSelect({ value, onChange, style, cwd }: Props) {
  const { t } = useI18n();
  const [grouped, setGrouped] = useState<[string, ModelOption[]][]>([]);
  const [loaded, setLoaded] = useState(false);
  const [defaultModel, setDefaultModel] = useState<{ provider: string; modelId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/models${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        const list = (data?.modelList ?? []) as { id: string; name: string; provider: string }[];
        setDefaultModel(data?.defaultModel ?? null);
        const byProvider = new Map<string, ModelOption[]>();
        for (const m of list) {
          const p = m.provider || "other";
          if (!byProvider.has(p)) byProvider.set(p, []);
          byProvider.get(p)!.push({
            value: m.provider ? `${m.provider}/${m.id}` : m.id,
            label: m.name,
          });
        }
        // 排序：各组内按 label 排
        for (const opts of byProvider.values()) {
          opts.sort((a, b) => a.label.localeCompare(b.label, "zh-CN", { numeric: true }));
        }
        // 按 provider 名排序
        const sorted = [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"));
        setGrouped(sorted);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const flatOptions = grouped.flatMap(([, opts]) => opts);
  const hasCurrent = value === "" || flatOptions.some((o) => o.value === value);
  const allGrouped: [string, ModelOption[]][] = hasCurrent ? grouped : [["当前", [{ value, label: value }]], ...grouped];

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={style} disabled={!loaded}>
      <option value="">
        {t("team.settings.defaultModel")}
        {defaultModel?.modelId ? ` · ${defaultModel.modelId}` : ""}
      </option>
      {allGrouped.map(([provider, opts]) => (
        <optgroup key={provider} label={provider}>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
