/**
 * DSH 兼容运行时：真 Cordis + Pi 能力作为 Service 注入。
 *
 * 复用真实 `@deepseek-ai/cordis` 运行时（不 shim），把 Pi 的能力写成
 * `extends Service` 的适配器（ctx.fs / ctx.tools / ctx.systemPrompt），然后
 * 加载真实 DSH 插件。POC 已证明 dsh-tool-fs 由此脱离 DSH CLI 跑通 read/write/edit。
 *
 * 关键约定：Pi 侧只依赖 @deepseek-ai/cordis（宿主运行时）；dsh-fs / dsh-tools /
 * dsh-system-prompt 等是「插件侧」依赖，随插件包一起安装在插件目录里。
 * 因此 PiFsService 用本地类型（结构兼容 dsh-fs 契约），不 import dsh-fs。
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";

/* ── 结构兼容 dsh-fs 契约的本地类型（docs/dsh/services.md） ── */

export interface DshFsTarget {
  targetKey: string;
  displayPath: string;
}

export interface DshFsInfo {
  version: string;
  type: "file" | "directory" | "other";
  size?: number;
}

export interface DshFsWriteOutcome {
  operation: "create" | "update";
  version: string;
  before: string | null;
  after: string;
}

export interface DshFsEditRequest {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export interface DshFsEditOutcome {
  version: string;
  before: string;
  after: string;
}

/** DSH 插件注册的工具（原始形态，桥接前）。
 *  注意：dsh-tools 的 defineTool 已把 parameters 转成标准 JSON Schema
 *  （{type:"object",properties,required}），且 execute 已包装（内部 validate）。 */
export interface DshTool {
  name: string;
  description: string;
  parameters: unknown; // 标准 JSON Schema（defineTool 转换后的产物）
  output?: {
    schema?: unknown;
    render?: (args: unknown, value: unknown) => Array<{ type: string; text: string }>;
    presentationMeta?: (args: unknown, value: unknown) => unknown;
  };
  isConcurrencySafe?: (args: unknown) => boolean;
  execute(args: unknown, exec: DshExec): Promise<unknown>;
}

export interface DshExec {
  signal?: AbortSignal;
  callId?: string;
  agent?: { session?: { header?: { cwd?: string } } };
}

/** 一个 DSH 插件入口（三形态归一化后）。 */
export interface DshPluginEntry {
  name?: string;
  inject?: string[];
  apply: (ctx: unknown, config?: unknown) => unknown;
  Config?: unknown;
}

/* ── Pi 能力 Service ── */

/**
 * Pi 的文件能力，写成 Cordis `fs` Service。文件访问经 Pi 的允许根校验
 * （lib/file-access.ts），所以 DSH 工具的 read/write/edit 自动受 Pi 的安全
 * 边界约束，而不是 DSH 的沙箱。
 */
class PiFsService extends Service {
  constructor(ctx: Context) {
    super(ctx, "fs");
  }

  /** 裸后端不沙箱 → dsh-tool-fs 不读 sandboxPolicy/approval。 */
  get sandboxMode(): undefined {
    return undefined;
  }

  async resolve(p: string, opts: { cwd?: string } = {}): Promise<DshFsTarget> {
    const abs = path.resolve(opts.cwd ?? process.cwd(), p);
    const roots = await getAllowedFileRoots();
    if (!isFilePathAllowed(abs, roots)) {
      throw new Error(`path "${abs}" is outside Pi Studio allowed roots`);
    }
    const real = await fsp.realpath(abs).catch(() => abs);
    return { targetKey: real, displayPath: abs };
  }

  processPath(target: DshFsTarget): string {
    return target.targetKey;
  }

  fileUrl(target: DshFsTarget): string {
    return "file://" + target.targetKey.replace(/\\/g, "/");
  }

  contains(parent: DshFsTarget, child: DshFsTarget): boolean {
    const rel = path.relative(parent.targetKey, child.targetKey);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  }

  async stat(target: DshFsTarget): Promise<DshFsInfo | undefined> {
    try {
      const st = await fsp.stat(target.targetKey);
      return {
        version: `${st.mtimeMs}-${st.size}-${st.ino ?? 0}`,
        type: st.isDirectory() ? "directory" : st.isFile() ? "file" : "other",
        size: st.size,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  async lstat(p: string, opts: { cwd?: string } = {}): Promise<DshFsInfo | undefined> {
    try {
      const abs = path.resolve(opts.cwd ?? process.cwd(), p);
      const st = await fsp.lstat(abs);
      return {
        version: `${st.mtimeMs}-${st.size}-${st.ino ?? 0}`,
        type: st.isDirectory() ? "directory" : st.isFile() ? "file" : "other",
        size: st.size,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  async readText(target: DshFsTarget): Promise<string> {
    const buf = await fsp.readFile(target.targetKey);
    if (buf.includes(0)) throw new Error(`cannot read "${target.displayPath}": binary file`);
    return buf.toString("utf8");
  }

  async streamText(target: DshFsTarget): Promise<AsyncIterable<string>> {
    const text = await this.readText(target);
    return (async function* () {
      yield text;
    })();
  }

  async listDir(target: DshFsTarget): Promise<Array<{ name: string; type: string; target: DshFsTarget }>> {
    const entries = await fsp.readdir(target.targetKey, { withFileTypes: true });
    return entries.map((e) => {
      const child = path.join(target.targetKey, e.name);
      return {
        name: e.name,
        type: e.isDirectory() ? "directory" : e.isFile() ? "file" : "other",
        target: { targetKey: child, displayPath: child },
      };
    });
  }

  async writeText(
    target: DshFsTarget,
    content: string,
    expected?: { kind: string; version?: string },
  ): Promise<DshFsWriteOutcome> {
    const before = await fsp.readFile(target.targetKey, "utf8").catch(() => null);
    if (expected?.kind === "createIfAbsent" && before !== null) {
      throw new Error(`cannot write "${target.displayPath}": already exists`);
    }
    await fsp.mkdir(path.dirname(target.targetKey), { recursive: true });
    await fsp.writeFile(target.targetKey, content, "utf8");
    const st = await fsp.stat(target.targetKey);
    return {
      operation: before === null ? "create" : "update",
      version: `${st.mtimeMs}-${st.size}-${st.ino ?? 0}`,
      before,
      after: content,
    };
  }

  async editText(
    target: DshFsTarget,
    edit: DshFsEditRequest,
  ): Promise<DshFsEditOutcome> {
    const raw = await fsp.readFile(target.targetKey, "utf8").catch(() => null);
    if (raw === null) throw new Error(`cannot edit "${target.displayPath}": not found`);
    const before = raw.replace(/\r\n/g, "\n");
    const oldStr = edit.oldString.replace(/\r\n/g, "\n");
    const count = before.split(oldStr).length - 1;
    if (count === 0) throw new Error(`old_string not found in "${target.displayPath}"`);
    if (count > 1 && !edit.replaceAll) throw new Error(`old_string matches ${count} times in "${target.displayPath}"`);
    const newStr = edit.newString.replace(/\r\n/g, "\n");
    const after = edit.replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
    await fsp.writeFile(target.targetKey, after, "utf8");
    const st = await fsp.stat(target.targetKey);
    return {
      version: `${st.mtimeMs}-${st.size}-${st.ino ?? 0}`,
      before,
      after,
    };
  }
}

/** 最小 tool registry（ctx.tools）。DSH 插件经 `ctx.tools.register()` 注册工具。 */
class PiToolsService extends Service {
  private registry = new Map<string, DshTool>();

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  register(tool: DshTool): void {
    if (tool && typeof tool.name === "string") this.registry.set(tool.name, tool);
  }

  get(name: string): DshTool | undefined {
    return this.registry.get(name);
  }

  list(): DshTool[] {
    return [...this.registry.values()];
  }
}

/** 最小 system-prompt 段落注册（ctx.systemPrompt）。 */
class PiSystemPromptService extends Service {
  private sections = new Map<string, unknown>();

  constructor(ctx: Context) {
    super(ctx, "systemPrompt");
  }

  section(spec: { name: string; order?: number; text: string }): () => void {
    this.sections.set(spec.name, spec);
    return () => this.sections.delete(spec.name);
  }
}

/* ── 运行时 ── */

export interface DshRuntime {
  ctx: Context;
  tools: PiToolsService;
  /** 加载一个 DSH 插件入口，返回它注册的工具。 */
  loadPlugin(entry: DshPluginEntry, rawConfig?: unknown): Promise<DshTool[]>;
  dispose(): void;
}

export async function createDshRuntime(): Promise<DshRuntime> {
  const ctx = new Context();
  // Pi 能力注入（真 Cordis Service）。provide 必须在 fiber 上下文里，
  // 所以经 ctx.plugin 挂载并 await 完成（否则 ctx.tools 尚未就位）。
  await ctx.plugin((c: Context) => {
    new PiFsService(c);
    new PiToolsService(c);
    new PiSystemPromptService(c);
  });
  // Cordis 的 Context 是 Proxy，属性经服务解析器解析；类型上无 tools 属性，用窄化读取。
  const tools = (ctx as unknown as { tools: PiToolsService }).tools;

  return {
    ctx,
    tools,
    async loadPlugin(entry, rawConfig) {
      const before = new Set(tools.list().map((t) => t.name));
      // Cordis Plugin 类型参数化严格；entry 已由 normalizeDshModule 归一化成三形态之一。
      await (ctx.plugin as unknown as (plugin: unknown, config?: unknown) => Promise<unknown>)(
        {
          name: entry.name,
          inject: entry.inject ?? [],
          apply: entry.apply,
          ...(entry.Config !== undefined ? { Config: entry.Config } : {}),
        },
        rawConfig ?? {},
      );
      const after = tools.list();
      // 只返回本次新增的工具（避免重复上报）
      const added = after.filter((t) => !before.has(t.name));
      return added.length > 0 ? added : after;
    },
    dispose() {
      ctx.fiber.dispose();
    },
  };
}

/** 把一个动态 import 的 DSH 插件模块归一化成 DshPluginEntry。 */
export function normalizeDshModule(mod: unknown): DshPluginEntry | null {
  const m = mod as Record<string, unknown>;
  const apply = (m?.apply ?? (m?.default as Record<string, unknown> | undefined)?.apply ?? m?.default) as
    | ((ctx: unknown, config?: unknown) => unknown)
    | undefined;
  if (typeof apply !== "function") return null;
  const meta = (typeof m?.default === "object" && m.default !== null ? m.default : m) as Record<string, unknown>;
  return {
    name: (meta.name as string) ?? (typeof m?.default === "function" ? (m.default as { name?: string }).name : undefined),
    inject: (meta.inject as string[]) ?? [],
    apply,
    Config: meta.Config,
  };
}
