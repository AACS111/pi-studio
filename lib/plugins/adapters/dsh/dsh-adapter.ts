/**
 * DSH adapter 入口：一个已安装的 DSH 插件包 → PiStudioPlugin + 桥接产物。
 *
 * 链路（docs/dsh/README.md）：
 *   npm 包 → import → normalizeDshModule → 真 Cordis 运行时挂载
 *   → ctx.tools 收集 DSH tools → dshToolsToPiTools 桥接成 pi ToolDefinition
 *   → 识别 SKILL.md 目录 → 汇总 DshPluginArtifacts。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { DshPluginArtifacts, CompatReport, PiStudioPlugin } from "../../core/types";
import { registerPlugin, listPlugins } from "../../core/plugin-registry";
import { DSH_CTX_SERVICES, DSH_CONTRACT_VERSION } from "./dsh-contract";
import { createDshRuntime, normalizeDshModule } from "./dsh-runtime";
import { dshToolsToPiTools } from "./dsh-tool-adapter";
import { listInstalledPlugins, loadPluginModule, pluginModulePath } from "./dsh-plugin-store";
import { registerDshClientExtension } from "./dsh-client-adapter";

/** 已知可提供的服务名（Pi 宿主已实现或计划实现的 ctx 服务）。 */
const KNOWN_SERVICES = new Set<string>([...DSH_CTX_SERVICES]);

/** pi 内置 coding 工具名（rpc-manager.ts 的 CODING_TOOL_NAMES）。
 *  DSH 插件若注册同名工具（如 dsh-tool-fs 的 read/write/edit），会覆盖 pi 内置
 *  （pi 的 read 支持图片，DSH 的只支持 UTF-8 文本——覆盖即能力退化）。
 *  所以同名工具跳过，保留 pi 内置。 */
const PI_CODING_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** 递归找插件包内的 SKILL.md 目录（跳过 node_modules，限制深度）。 */
function findSkillPaths(root: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 4) return out;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (existsSync(join(full, "SKILL.md"))) {
        out.push(full);
      } else {
        out.push(...findSkillPaths(full, depth + 1));
      }
    }
  }
  return out;
}

export interface DshLoadResult {
  artifacts: DshPluginArtifacts;
  compat: CompatReport;
}

/**
 * 加载并桥接一个已安装的 DSH 插件包。
 * 返回产物（tools + skillPaths）+ 兼容性报告。
 *
 * 「host 侧不可用」的三种情况（import 失败 / 无有效入口 / inject 宿主 seam）
 * 统一降级为「仅 client 侧」产物而非抛错：client.js 是独立 bundle，host 侧
 * 依赖（node-pty/ws 等）缺失不影响 client UI 加载（dsh-client-adapter 负责）。
 */
export async function loadDshPlugin(pkg: string): Promise<DshLoadResult> {
  const pkgPath = pluginModulePath(pkg);
  const skillPaths = findSkillPaths(pkgPath);
  const version = readVersion(pkg);
  const clientOnly = (note: string, unmapped: string[] = []): DshLoadResult => ({
    compat: {
      score: 0,
      verified: false,
      unmapped,
      notes: [`${note} — 仅 client 侧`],
    },
    artifacts: { packageName: pkg, version, tools: [], skillPaths, unmappedServices: unmapped },
  });

  let mod: unknown;
  try {
    mod = await loadPluginModule(pkg);
  } catch (error) {
    // host 入口 import 失败（缺 node-pty/ws/dsh-settings 等依赖）→ 仅 client 侧。
    return clientOnly(`host entry import failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const entry = normalizeDshModule(mod);
  if (!entry) {
    // host 入口无有效插件入口（纯 client 插件）→ 仅 client 侧。
    return clientOnly("no valid host plugin entry (client-only)");
  }

  const unmapped = (entry.inject ?? []).filter((s) => !KNOWN_SERVICES.has(s));
  if (unmapped.length > 0) {
    // host 侧 inject 了 Pi 未提供的服务（webServer/session/terminal 等宿主 seam）→
    // Cordis 挂载会因服务缺失而 PENDING（await 永远不 resolve），跳过 host 桥接。
    return clientOnly(`host seam unavailable: ${unmapped.join(", ")}`, unmapped);
  }

  const runtime = await createDshRuntime();
  let tools: ReturnType<typeof dshToolsToPiTools>;
  let skippedConflicts = 0;
  try {
    const dshTools = await runtime.loadPlugin(entry);
    const bridged = dshToolsToPiTools(dshTools);
    tools = bridged.filter((t) => !PI_CODING_TOOL_NAMES.has(t.name));
    skippedConflicts = bridged.length - tools.length;
  } finally {
    // 挂载完成后即可 dispose（工具已收集）；插件本身的 apply 已执行完。
    runtime.dispose();
  }

  const compat: CompatReport = {
    score: 100,
    verified: tools.length > 0,
    unmapped,
    notes: [
      `DSH ${DSH_CONTRACT_VERSION}`,
      tools.length > 0 ? `bridged ${tools.length} tool(s)` : "no tools registered",
      skippedConflicts > 0 ? `skipped ${skippedConflicts} tool(s) conflicting with pi builtins` : undefined,
      skillPaths.length > 0 ? `found ${skillPaths.length} skill dir(s)` : undefined,
    ].filter((n): n is string => typeof n === "string"),
  };

  return {
    compat,
    artifacts: {
      packageName: pkg,
      version,
      tools,
      skillPaths,
      unmappedServices: unmapped,
    },
  };
}

function readVersion(pkg: string): string {
  try {
    const pkgJson = join(pluginModulePath(pkg), "package.json");
    const parsed = JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** 构造统一的 PiStudioPlugin 描述（供 registry / 市场使用）。 */
export function describeDshPlugin(pkg: string, result: DshLoadResult): PiStudioPlugin {
  return {
    id: `dsh:${pkg}`,
    name: pkg,
    version: result.artifacts.version,
    origin: "dsh",
    compat: result.compat,
    activate() {
      // 加载已在 loadDshPlugin 完成；activate 是统一契约的占位。
      // 实际产物经 plugin-registry 注入 session。
    },
  };
}

/* ── 加载并缓存所有已安装插件 ── */

declare global {
  var __piDshLoadPromise: Promise<void> | undefined;
}

/**
 * 加载所有已安装的 DSH 插件并缓存桥接产物（幂等，globalThis 锁防并发重复加载）。
 * 单个插件加载失败不阻塞整体（记录到 registry 之外，仅跳过）。
 */
export function ensureDshPluginsLoaded(): Promise<void> {
  if (!globalThis.__piDshLoadPromise) {
    globalThis.__piDshLoadPromise = (async () => {
      const installed = listInstalledPlugins();
      const loaded = new Set(listPlugins().map((p) => p.id));
      for (const pkg of installed) {
        const id = `dsh:${pkg}`;
        // 1) host 侧：工具 / 技能桥接（真 Cordis + Pi Service）
        if (!loaded.has(id)) {
          try {
            const result = await loadDshPlugin(pkg);
            registerPlugin({
              id,
              origin: "dsh",
              name: pkg,
              version: result.artifacts.version,
              compat: result.compat,
              artifacts: result.artifacts,
              loadedAt: Date.now(),
            });
          } catch (error) {
            console.error(
              `[pi-studio] failed to load DSH plugin "${pkg}":`,
              error instanceof Error ? error.message : error,
            );
          }
        }
        // 2) client 侧：UI 扩展注册（纯 client 插件无 host 入口也能进 Pi 侧边栏）
        try {
          registerDshClientExtension(pkg);
        } catch (error) {
          console.error(
            `[pi-studio] failed to register DSH client extension "${pkg}":`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    })().finally(() => {
      globalThis.__piDshLoadPromise = undefined;
    });
  }
  return globalThis.__piDshLoadPromise;
}
