/**
 * 任务 DAG 分层布局（执行回放 UI 用，纯函数）。
 *
 * 最长路径分层：layer(t) = 0（无依赖）或 max(layer(dep)) + 1。
 * 同层任务排成一列（可并行展示），相邻层连线表达依赖。
 * 防御性：依赖引用不存在的 id 忽略；意外成环时按 DFS 访问态截断（不死循环）。
 */

export interface DagTaskLike {
  id: string;
  title: string;
  assignedAgentId: string;
  status: string;
  dependsOn?: string[];
  planTaskId?: string;
  retries?: number;
  description?: string;
}

export interface DagLayout {
  /** 每层包含的任务 id（按传入顺序；层号即并行波次号） */
  layers: string[][];
  /** taskId → 层号 */
  layerOf: Map<string, number>;
}

export function computeDagLayers(tasks: DagTaskLike[]): DagLayout {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();

  const layerOfTask = (id: string): number => {
    if (layerOf.has(id)) return layerOf.get(id)!;
    if (visiting.has(id)) return 0; // 环：按 0 层截断（正常数据经校验无环，防御而已）
    visiting.add(id);
    const task = byId.get(id);
    let layer = 0;
    for (const dep of task?.dependsOn ?? []) {
      if (!byId.has(dep)) continue; // 引用不存在的依赖忽略
      layer = Math.max(layer, layerOfTask(dep) + 1);
    }
    visiting.delete(id);
    layerOf.set(id, layer);
    return layer;
  };

  for (const t of tasks) layerOfTask(t.id);

  const maxLayer = Math.max(-1, ...tasks.map((t) => layerOf.get(t.id) ?? 0));
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const t of tasks) {
    const l = layerOf.get(t.id) ?? 0;
    if (!layers[l]) layers[l] = [];
    layers[l].push(t.id);
  }
  return { layers, layerOf };
}

/** 任务状态 → 展示色（与团队 UI 的状态语义一致） */
export function dagStatusColor(status: string): string {
  switch (status) {
    case "completed": return "#2ec27e";
    case "failed": return "#e5484d";
    case "running": return "#3b82f6";
    case "cancelled": return "#9898a0";
    default: return "#8a8a95"; // pending
  }
}

/** 任务状态 → 图标 */
export function dagStatusIcon(status: string): string {
  switch (status) {
    case "completed": return "✅";
    case "failed": return "❌";
    case "running": return "🔄";
    case "cancelled": return "⏹️";
    default: return "⏳";
  }
}
