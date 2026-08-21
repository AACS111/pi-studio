"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import * as React from "react";
import * as ReactDOMClient from "react-dom/client";
import type { PiUiExtension } from "@/lib/plugins/ui/types";
import { createPiSessions, createPiWorkspaces, createPiConnection, createPiLocale } from "@/lib/plugins/adapters/dsh/dsh-client-services";

/**
 * DSH client 插件前端加载器（最小闭环）。
 *
 * 让 DSH client 插件的 `apply(ctx)` 在 Pi 前端跑起来，`ctx.slots.inject(...)`
 * 注册的 React 组件落到 Pi UI 渲染容器。原则（用户定义）：DSH client 插件
 * 不知道 Pi —— 它只看到 DSH 的 `ctx`（slots / locale / effect / get / on），
 * Pi 侧提供这些 API 的轻量兼容实现。
 *
 * 注意：这是「最小闭环」——用轻量 ctx 而非真 Cordis runtime（真 Cordis 的
 * 浏览器端接入 + 完整 client 服务见 docs/dsh/client-adapter.md 第 4/5 步）。
 * 真 DSH 插件若 inject 了未实现的服务（sessions/workspaces/connection…），
 * 会在 apply 时读不到对应 ctx 属性而报错（这是预期的：兼容度受限）。
 */

/* ── 运行时 slot store（挂 window，跨 loader 与渲染容器通信） ── */

export interface SlotRegistration {
  slotName: string;
  id: string;
  component: ComponentType<Record<string, unknown>>;
  order?: number;
  /** DSH slot 协议：渲染时宿主调用 inject(owner?) 取组件 props（表单状态/动作等）。 */
  inject?: (owner?: unknown) => Record<string, unknown>;
  /** selective slot：渲染时宿主先调 select(owner)，返回 null 则不渲染该组件。 */
  select?: (owner?: unknown) => unknown;
  /** slot 的 locale 命名空间（渲染时查字典构建 t）。 */
  locale?: string;
}

declare global {
  interface Window {
    __ModuleLoader__?: {
      load(module: { id: string; factory: (require: (specifier: string) => unknown) => unknown }): void;
    };
    __piDshClientSlots?: Map<string, SlotRegistration>;
    __piDshClientModules?: Map<string, { apply: (ctx: unknown) => unknown; inject: string[] }>;
  }
}

function slotStore(): Map<string, SlotRegistration> {
  if (!window.__piDshClientSlots) window.__piDshClientSlots = new Map();
  return window.__piDshClientSlots;
}

/** 列出当前已注册的 DSH client slot 组件（供渲染容器消费）。 */
export function listClientSlots(): SlotRegistration[] {
  return [...slotStore().values()].sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000));
}

/** 订阅 slot 变化（渲染容器在加载完成后重新读取）。 */
export function subscribeClientSlots(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener("pi-dsh-slots-changed", handler);
  return () => window.removeEventListener("pi-dsh-slots-changed", handler);
}

function notifySlotsChanged(): void {
  window.dispatchEvent(new Event("pi-dsh-slots-changed"));
}

/* ── 模块加载器（window.__ModuleLoader__） ── */

/** react / react-dom 由 Pi 前端提供；jsx-runtime 与 ui-primitives 给最小 stub。 */
// react/jsx-runtime：jsx(type, props, key) ≈ createElement(type, {...props, key})
const jsxRuntime = {
  jsx: (type: React.ElementType, props: Record<string, unknown> | null, key: string | undefined) =>
    React.createElement(type, key !== undefined ? { ...(props ?? {}), key } : (props ?? {})),
  jsxs: (type: React.ElementType, props: Record<string, unknown> | null, key: string | undefined) =>
    React.createElement(type, key !== undefined ? { ...(props ?? {}), key } : (props ?? {})),
  Fragment: React.Fragment,
};

// @deepseek-ai/dsh-client-ui-primitives 最小 stub：
// 图标返回空 SVG，交互组件返回原生元素，writeClipboard 走 navigator.clipboard。
// 样式依赖 DSH 的 --dsw-* 变量，后续「样式映射」阶段补（docs/dsh/client-adapter.md）。
function iconStub(name: string) {
  return function Icon(props: Record<string, unknown>) {
    return React.createElement("svg", {
      ...props,
      "data-dsh-icon": name,
      width: 16,
      height: 16,
      viewBox: "0 0 16 16",
    });
  };
}
const UI_PRIMITIVES: Record<string, unknown> = {
  Button: (p: Record<string, unknown>) => React.createElement("button", p),
  Input: (p: Record<string, unknown>) => React.createElement("input", p),
  Menu: (p: Record<string, unknown>) => React.createElement("div", p),
  Modal: (p: Record<string, unknown>) => React.createElement("div", p),
  StateDot: (p: Record<string, unknown>) => React.createElement("span", p),
  Tooltip: (p: Record<string, unknown>) => React.createElement("span", p),
  writeClipboard: (text: string) => (navigator.clipboard?.writeText(text) ?? Promise.resolve()),
  IconBranchOutline16: iconStub("branch"),
  IconCheckOutline16: iconStub("check"),
  IconChevronLeftOutline14: iconStub("chevron-left"),
  IconChevronRightOutline14: iconStub("chevron-right"),
  IconCloseFill14: iconStub("close"),
  IconCodeOutline16: iconStub("code"),
  IconCopyOutline16: iconStub("copy"),
  IconDownloadOutline16: iconStub("download"),
  IconFolderClose16: iconStub("folder"),
  IconFolderOpen16: iconStub("folder-open"),
  IconLinkOutline14: iconStub("link"),
  IconPlusOutline16: iconStub("plus"),
  IconRefreshOutline14: iconStub("refresh"),
  IconRefreshOutline16: iconStub("refresh"),
  IconRightUpOutline16: iconStub("right-up"),
  IconSettingsOutline16: iconStub("settings"),
  IconThinkOutline16: iconStub("think"),
  IconTrashOutline16: iconStub("trash"),
  IconWarningOutline16: iconStub("warning"),
};

const requireMap: Record<string, unknown> = {
  react: React,
  "react-dom": ReactDOMClient,
  "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": jsxRuntime,
  "@deepseek-ai/dsh-client-ui-primitives": UI_PRIMITIVES,
  // @deepseek-ai/dsh-client-runtime/client 最小 stub：
  // dsh-live-stats 等纯 client 插件用 createSnapshotStore 做表单/统计状态
  // （getSnapshot / set / subscribe，React 18 快照 store 协议）。
  "@deepseek-ai/dsh-client-runtime/client": {
    createSnapshotStore(initial: unknown) {
      let value = initial;
      const listeners = new Set<() => void>();
      return {
        getSnapshot: () => value,
        set(next: unknown) {
          value = next;
          for (const fn of listeners) fn();
        },
        subscribe(fn: () => void) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
      };
    },
  },
};

function ensureModuleLoader(): void {
  if (window.__ModuleLoader__) return;
  if (!window.__piDshClientModules) window.__piDshClientModules = new Map();
  window.__ModuleLoader__ = {
    load({ id, factory }) {
      const exports = factory((specifier: string) => {
        if (specifier in requireMap) return requireMap[specifier];
        throw new Error(`[pi-studio] DSH client module "${id}" requires unsupported dependency: ${specifier}`);
      });
      const mod = (exports ?? {}) as { apply?: (ctx: unknown) => unknown; inject?: string[] };
      if (typeof mod.apply === "function") {
        window.__piDshClientModules!.set(id, { apply: mod.apply, inject: mod.inject ?? [] });
      }
    },
  };
}

/* ── 轻量 client ctx（slots / locale / effect / get / on） ── */

interface ClientCtx {
  ctx: Record<string, unknown>;
  dispose: () => void;
}

function createClientCtx(): ClientCtx {
  const disposers: Array<() => void> = [];
  const store = slotStore();

  const slots = {
    /** DSH 插件侧：ctx.slots.register(descriptor, Component) → 注册组件，返回 disposer。 */
    register(
      descriptor: { name?: string; id?: string; order?: number },
      Component: ComponentType<Record<string, unknown>>,
    ): () => void {
      const slotName = descriptor.name ?? "slot";
      const id = descriptor.id ?? `slot-${store.size}`;
      // key 用 slotName::id 组合：同一插件可在多个 slot 注册同 id（dsh-live-stats
      // 在 web-ui.plugin.item 与 conversation.composer.dock 都用 id:"live-stats"）。
      const key = `${slotName}::${id}`;
      const desc = descriptor as {
        inject?: (owner?: unknown) => Record<string, unknown>;
        select?: (owner?: unknown) => unknown;
        locale?: string;
      };
      store.set(key, {
        slotName,
        id,
        component: Component,
        order: descriptor.order,
        inject: typeof desc.inject === "function" ? desc.inject : undefined,
        select: typeof desc.select === "function" ? desc.select : undefined,
        locale: desc.locale,
      });
      notifySlotsChanged();
      return () => {
        store.delete(key);
        notifySlotsChanged();
      };
    },
    /** DSH 插件侧：ctx.slots.inject(name, factory) → 执行 factory（其内部调 register）。 */
    inject(slotName: string, factory: () => unknown): void {
      const result = factory();
      if (typeof result === "function") {
        disposers.push(result as () => void);
      }
      void slotName;
    },
  };

  const locale = createPiLocale();
  const sessions = createPiSessions();
  const workspaces = createPiWorkspaces();
  const connection = createPiConnection();

  // 暴露 locale 字典给渲染层（PluginHost 渲染 slot 组件时需要查 descriptor.locale
  // 的字典构建 props.t；DSH 组件只见 DSH 的 key → 字符串翻译）。
  (window as unknown as { __piDshLocale?: { dict: (ns: string, lang: string) => Record<string, string> | undefined } }).__piDshLocale = {
    dict: locale.dict,
  };

  // DSH settingsScope（client 服务注入名）：bind({namespace}) → 表单 scope。
  // dsh-live-stats 的 LiveStatsSettingsCard 用它读/写设置（getSnapshot/subscribe/
  // set/unset）。最小实现：localStorage 持久化 + 订阅通知。
  const settingsScope = {
    bind({ namespace }: { namespace: string }) {
      const key = `pi-dsh-settings:${namespace}`;
      let value: Record<string, unknown> = {};
      try {
        const raw = window.localStorage.getItem(key);
        if (raw) value = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* 损坏时回退空对象 */
      }
      const listeners = new Set<() => void>();
      const persist = () => {
        try {
          window.localStorage.setItem(key, JSON.stringify(value));
        } catch {
          /* quota 满时静默 */
        }
      };
      const notify = () => {
        for (const fn of listeners) fn();
      };
      return {
        subscribe(fn: () => void) {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        getSnapshot: () => value,
        async set(field: string, v: unknown) {
          value = { ...value, [field]: v };
          persist();
          notify();
        },
        async unset(field: string) {
          const next = { ...value };
          delete next[field];
          value = next;
          persist();
          notify();
        },
      };
    },
  };

  const ctx: Record<string, unknown> = {
    slots,
    locale,
    sessions,
    workspaces,
    connection,
    settingsScope,
    provide(name: string, service: unknown): () => void {
      ctx[name] = service;
      return () => {
        delete ctx[name];
      };
    },
    effect(fn: () => void): () => void {
      disposers.push(fn);
      return () => {
        const i = disposers.indexOf(fn);
        if (i >= 0) disposers.splice(i, 1);
      };
    },
    get(name: string): unknown {
      return ctx[name];
    },
    on(): () => void {
      return () => {};
    },
  };

  // 后台拉取 Pi 会话/工作区数据（失败静默，插件侧有 fallback）。
  void sessions.refresh();
  void workspaces.refresh();

  return {
    ctx,
    dispose() {
      for (const d of disposers.splice(0)) {
        try { d(); } catch { /* ignore */ }
      }
    },
  };
}

/* ── 加载一个 DSH client 插件 ── */

export interface DshClientLoadResult {
  ok: boolean;
  error?: string;
  /** apply 声明的 client 服务依赖。 */
  inject: string[];
}

/** 加载一个 DSH client 插件并跑 apply（幂等：同插件只跑一次）。 */
export async function loadDshClientPlugin(ext: PiUiExtension): Promise<DshClientLoadResult> {
  ensureModuleLoader();
  // client.js 里 window.__ModuleLoader__.load({ id: "<pkg>" }) 用的是纯包名
  // （如 "dsh-better-sidebar"），不是带生态前缀的扩展 id（"dsh:dsh-better-sidebar"）。
  const pkg = ext.pluginId.startsWith("dsh:") ? ext.pluginId.slice(4) : ext.pluginId;
  const moduleId = pkg;
  const modules = window.__piDshClientModules!;
  if (modules.has(moduleId)) {
    return { ok: true, inject: modules.get(moduleId)!.inject };
  }

  // 从受控 API 拉取 client.js（pkg 即纯包名）。
  const res = await fetch(`/api/dsh/client-script?pkg=${encodeURIComponent(pkg)}`);
  if (!res.ok) {
    return { ok: false, error: `client script fetch failed (${res.status})`, inject: [] };
  }
  const code = await res.text();

  try {
    // client.js 是 UMD：执行后触发 window.__ModuleLoader__.load({id, factory})。
    const run = new Function("window", "self", "globalThis", code);
    run(window, window, window);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), inject: [] };
  }

  const mod = modules.get(moduleId);
  if (!mod) {
    return { ok: false, error: "module registered no {apply,inject} export", inject: [] };
  }

  // 跑 apply（轻量 ctx）。
  const { ctx, dispose } = createClientCtx();
  try {
    mod.apply(ctx);
  } catch (error) {
    dispose();
    return { ok: false, error: error instanceof Error ? error.message : String(error), inject: mod.inject };
  }
  // 注意：不 dispose —— slots 注册的组件要保留在 store 供渲染。
  return { ok: true, inject: mod.inject };
}

/* ── hook：加载扩展的 client 插件并暴露 slot 组件 ── */

export function useDshClientPlugin(ext: PiUiExtension | null): {
  slots: SlotRegistration[];
  loading: boolean;
  error: string | null;
} {
  const [slots, setSlots] = useState<SlotRegistration[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const reload = useCallback(async () => {
    if (!ext || !ext.client) return;
    if (loadedRef.current) return;
    setLoading(true);
    setError(null);
    const result = await loadDshClientPlugin(ext);
    setLoading(false);
    if (result.ok) {
      loadedRef.current = true;
      setSlots(listClientSlots());
    } else {
      setError(result.error ?? "load failed");
    }
  }, [ext]);

  useEffect(() => {
    if (ext?.client) {
      loadedRef.current = false;
      void reload();
    }
    const unsub = subscribeClientSlots(() => setSlots(listClientSlots()));
    return unsub;
  }, [ext, reload]);

  return { slots, loading, error };
}
