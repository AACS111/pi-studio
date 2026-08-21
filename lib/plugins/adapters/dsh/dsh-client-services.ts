/**
 * Pi → DSH client 服务的映射实现（浏览器端运行）。
 *
 * DSH client 插件（如 dsh-better-sidebar）的 apply(ctx) 通过 ctx.sessions /
 * ctx.workspaces / ctx.connection / ctx.locale / ctx.provide 使用 DSH Web GUI
 * 的 client runtime 能力。这里把这些能力映射到 Pi Studio 自己的数据面：
 *
 *   ctx.sessions.list.getSnapshot()  →  /api/sessions（Pi 会话列表）
 *   ctx.sessions.scope(id)           →  最小 scoped 对象（Pi 无 scope tree）
 *   ctx.workspaces.openPath(path)    →  /api/open-file-request（右侧面板开文件）
 *   ctx.workspaces.list              →  /api/sessions 的 projectRoot 去重
 *   ctx.connection.api.*             →  安全 RPC stub（未接 Pi 的深 RPC 面）
 *   ctx.locale.register(ns, lang, d) →  三参数字典（DSH 语义）
 *
 * 原则：DSH 插件不知道 Pi；它看到的还是 DSH 的 ctx。未实现的深层语义
 * （subagents catalog、conversation input、session scope tree）返回空/undefined，
 * 插件侧自带 fallback（如 dsh-better-sidebar 的 appendToDraft 遇 undefined 即跳过）。
 */

/* ── 类型（DSH 契约子集，见 dsh-client-contract.ts） ── */

export interface DshSessionSummary {
  id: string;
  title?: string;
  displayTitle: string;
  cwd?: string;
  running: boolean;
  blank: boolean;
  updatedAt: number;
}

export interface DshSessionListState {
  ids: string[];
  byId: Record<string, DshSessionSummary>;
  current: string | undefined;
  phase: "loading" | "ready" | "error";
  subagentsByParent: Record<string, unknown>;
  jobsBySession: Record<string, unknown>;
}

interface PiSessionInfo {
  id: string;
  cwd?: string;
  name?: string;
  projectRoot?: string;
  timestamp?: number;
}

/* ── 工具 ── */

function displayTitleOf(s: PiSessionInfo): string {
  if (s.name) return s.name;
  const base = s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
  return base ?? s.id;
}

/** 轻量快照 store（DSH 的 SnapshotStore 语义：getSnapshot + subscribe）。 */
function createSnapshotStore<S>(initial: S) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    set(next: S) {
      snapshot = next;
      for (const l of listeners) l();
    },
    patch(partial: Partial<S>) {
      snapshot = { ...snapshot, ...partial };
      for (const l of listeners) l();
    },
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/* ── sessions（→ /api/sessions） ── */

export function createPiSessions() {
  const store = createSnapshotStore<DshSessionListState>({
    ids: [],
    byId: {},
    current: undefined,
    phase: "loading",
    subagentsByParent: {},
    jobsBySession: {},
  });

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as {
        sessions?: PiSessionInfo[];
        runningSessionIds?: string[];
      };
      const running = new Set<string>(Array.isArray(data.runningSessionIds) ? data.runningSessionIds : []);
      const list = Array.isArray(data.sessions) ? data.sessions : [];
      const byId: Record<string, DshSessionSummary> = {};
      for (const s of list) {
        byId[s.id] = {
          id: s.id,
          title: s.name,
          displayTitle: displayTitleOf(s),
          cwd: s.cwd,
          running: running.has(s.id),
          blank: !s.name,
          updatedAt: s.timestamp ?? Date.now(),
        };
      }
      store.set({
        ids: list.map((s) => s.id),
        byId,
        current: store.getSnapshot().current ?? list[0]?.id,
        phase: "ready",
        subagentsByParent: {},
        jobsBySession: {},
      });
    } catch {
      store.patch({ phase: "error" });
    }
  }

  return {
    list: {
      getSnapshot: store.getSnapshot,
      subscribe: store.subscribe,
    },
    /** 最小 scope：只带 sessionId（Pi 无 DSH 的 scope tree）。 */
    scope(id: string) {
      return { sessionId: id };
    },
    /** 最小 binding：session face 只提供 rename 占位。 */
    binding(id: string) {
      return {
        sessionId: id,
        session: { rename: async () => {} },
        ctx: {},
      };
    },
    open(id: string) {
      store.patch({ current: id });
    },
    refresh,
  };
}

/* ── workspaces（→ /api/sessions projectRoot 去重 + open-file-request） ── */

export interface DshWorkspaceView {
  workspaceId: string;
  title: string;
  path: string;
}

export function createPiWorkspaces() {
  const store = createSnapshotStore<{ items: DshWorkspaceView[]; phase: "loading" | "ready" | "error" }>({
    items: [],
    phase: "loading",
  });

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { sessions?: PiSessionInfo[] };
      const list = Array.isArray(data.sessions) ? data.sessions : [];
      const seen = new Set<string>();
      const items: DshWorkspaceView[] = [];
      for (const s of list) {
        const root = s.projectRoot ?? s.cwd;
        if (!root || seen.has(root)) continue;
        seen.add(root);
        items.push({
          workspaceId: root,
          title: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
          path: root,
        });
      }
      store.set({ items, phase: "ready" });
    } catch {
      store.patch({ phase: "error" });
    }
  }

  return {
    list: {
      getSnapshot: store.getSnapshot,
      subscribe: store.subscribe,
    },
    /** DSH 的单一文件打开漏斗 → Pi 右侧面板。 */
    async openPath(path: string): Promise<void> {
      try {
        await fetch("/api/open-file-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath: path }),
        });
      } catch {
        // ignore
      }
    },
    async connectWorkspace(id: string): Promise<void> {
      // Pi 无「切换工作区」语义；由 cwd 选择承担。
      void id;
    },
    refresh,
  };
}

/* ── connection（安全 RPC stub） ── */

type RpcOk = { result: { ok: true; value: unknown } };

function rpcOk(value: unknown = {}): RpcOk {
  return { result: { ok: true, value } };
}

/** 深层 stub：任何未实现的方法调用都返回 ok({})。 */
function rpcStub(): unknown {
  const fn = async () => rpcOk({});
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      return rpcStub();
    },
  });
}

export function createPiConnection() {
  const api: Record<string, unknown> = {
    subagents: {
      history: async () => rpcOk({ events: [] }),
    },
    agentPresets: {
      list: async () => rpcOk({ presets: [] }),
      select: async () => rpcOk({}),
    },
    sessions: {
      history: async () => rpcOk({ events: [] }),
    },
  };
  return {
    api: new Proxy(api, {
      get(target, prop) {
        const key = String(prop);
        if (key in target) return target[key];
        return rpcStub();
      },
    }),
  };
}

/* ── locale（三参数：register(ns, lang, dict) + DSH locale 服务协议） ── */

/**
 * DSH locale 服务协议（@deepseek-ai/dsh-client-locale）：
 *  - register(ns, lang, dict)：注册字典
 *  - getSnapshot() → { active, preference }：当前语言快照（better-sidebar 的
 *    attachLocale(ctx.locale) 存为 localeService 后调 getSnapshot().active）
 *  - subscribe(cb)：语言变化订阅（侧边栏根 re-render）
 */
export function createPiLocale() {
  const dicts: Record<string, Record<string, Record<string, string>>> = {};
  const listeners = new Set<() => void>();

  const activeLang = (): "zh" | "en" => {
    try {
      const stored = window.localStorage.getItem("pi-locale");
      if (stored === "zh-CN") return "zh";
      if (stored === "en") return "en";
    } catch {
      /* ignore */
    }
    const nav = window.navigator?.language ?? "";
    return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
  };

  return {
    register(ns: string, lang: string, dict: Record<string, string>): () => void {
      (dicts[ns] ??= {})[lang] = dict;
      return () => {
        delete dicts[ns]?.[lang];
      };
    },
    /** 取某个命名空间某语言的字典（供渲染层查词，可选）。 */
    dict(ns: string, lang: string): Record<string, string> | undefined {
      return dicts[ns]?.[lang];
    },
    /** DSH locale 快照：{ active, preference }。 */
    getSnapshot(): { active: "zh" | "en"; preference: "zh" | "en" } {
      const active = activeLang();
      return { active, preference: active };
    },
    /** DSH locale 订阅（宿主切语言时通知；Pi 暂无运行时切语言事件，静默保留）。 */
    subscribe(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
