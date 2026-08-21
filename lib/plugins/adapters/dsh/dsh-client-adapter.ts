/**
 * DSH client adapter（服务端部分）。
 *
 * 读取已安装 DSH 插件的 `dsh.client` manifest + exports["./client"] 入口，
 * 把「client 插件」注册成 Pi 的 UI 扩展（sidebar entry 落进 ActivityBar）。
 * 真实 client UI 的渲染由前端 dsh-client-loader（window.__ModuleLoader__ +
 * client 服务的 Pi 实现）完成 —— 本文件只负责「检测 + 注册扩展元数据」。
 *
 * 原则（用户定义）：DSH client 插件不知道 Pi，它只看到 DSH 的 ctx。<br/>
 * Pi 侧提供 client 服务的映射，插件源码零改动。
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { DshClientManifest } from "./dsh-client-contract";
import { DSH_CLIENT_SERVICE_PACKAGES } from "./dsh-client-contract";
import { pluginModulePath } from "./dsh-plugin-store";
import { registerUiExtension } from "../../ui/ui-registry";
import type { PiUiExtension } from "../../ui/types";

/** 从已安装插件的 package.json 读取 dsh.client manifest。 */
export function loadDshClientManifest(pkg: string): DshClientManifest | null {
  try {
    const pkgJson = JSON.parse(readFileSync(join(pluginModulePath(pkg), "package.json"), "utf8")) as {
      dsh?: { client?: Record<string, unknown> };
    };
    const client = pkgJson.dsh?.client;
    if (!client || typeof client !== "object") return null;
    return {
      inject: Array.isArray(client.inject) ? (client.inject as string[]) : undefined,
      platform: typeof client.platform === "string" ? client.platform : undefined,
      entry: typeof client.entry === "string" ? client.entry : undefined,
      immediately: client.immediately === true,
    };
  } catch {
    return null;
  }
}

/** 解析 client 入口相对路径（exports["./client"] 优先，回退 dsh.client.entry）。 */
export function resolveDshClientEntry(pkg: string, manifest: DshClientManifest): string | null {
  if (manifest.entry) return manifest.entry.replace(/^\.\//, "");
  try {
    const pkgJson = JSON.parse(readFileSync(join(pluginModulePath(pkg), "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    const client = pkgJson.exports?.["./client"];
    if (typeof client === "string") return client.replace(/^\.\//, "");
    if (client && typeof client === "object") {
      const map = client as Record<string, unknown>;
      for (const key of ["default", "import", "require", "browser"]) {
        if (typeof map[key] === "string") return (map[key] as string).replace(/^\.\//, "");
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/** 解析插件名（供 sidebar 显示）。 */
function shortName(pkg: string): string {
  const last = pkg.split("/").pop() ?? pkg;
  return last.replace(/^dsh-(client-)?/, "").replace(/^ui-/, "");
}

/** 插件用到的 client 服务名（由依赖的服务包反推）。 */
function clientServicesOf(manifest: DshClientManifest): string[] {
  const out = new Set<string>();
  for (const p of manifest.inject ?? []) {
    for (const svc of DSH_CLIENT_SERVICE_PACKAGES[p] ?? []) out.add(svc);
  }
  return [...out];
}

/**
 * 为一个 DSH client 插件注册 Pi UI 扩展（sidebar entry）。
 * 返回注册的扩展；非 client 插件返回 null。
 */
export function registerDshClientExtension(pkg: string): PiUiExtension | null {
  const manifest = loadDshClientManifest(pkg);
  if (!manifest) return null;
  const entry = resolveDshClientEntry(pkg, manifest);
  if (!entry) return null;

  const id = `dsh:${pkg}`;
  const label = shortName(pkg);
  const ext: PiUiExtension = {
    id,
    pluginId: id,
    origin: "dsh",
    kind: "sidebar",
    title: label,
    description: `DSH client 插件（${manifest.platform ?? "web"}）`,
    sidebarEntry: { id: label, label, icon: "puzzle", order: 500 },
    client: {
      entry,
      inject: manifest.inject ?? [],
      platform: manifest.platform,
    },
    meta: { clientServices: clientServicesOf(manifest) },
  };
  registerUiExtension(ext);
  return ext;
}

/** 包目录里 client 入口文件是否真的存在（供检测用，不加载）。 */
export function hasDshClientEntry(pkg: string): boolean {
  const manifest = loadDshClientManifest(pkg);
  if (!manifest) return false;
  const entry = resolveDshClientEntry(pkg, manifest);
  if (!entry) return false;
  return existsSync(join(pluginModulePath(pkg), entry));
}
