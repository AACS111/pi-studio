/**
 * DSH 插件适配检测：安装前先回答「这个 DSH 插件能否被 Pi Studio 适配」。
 *
 * 检测维度（静态分析，不需要安装插件）：
 *   1. package.json manifest：dsh.bundle / dsh.client / exports / dependencies
 *   2. 入口源码（npm registry CDN）：ctx.<service> / ctx.get("<service>")
 *   3. 契约映射表：DSH seam → Pi 已实现能力 / Phase 3 未实现 / 宿主硬阻塞
 *
 * 只有 adaptable === true 的插件才允许进入安装流程；其余返回原因由市场面板展示。
 */
import type { DshPackageManifest } from "./dsh-contract.js";

/** DSH seam 的适配状态。 */
export type DshSeamStatus = "mapped" | "client" | "pending" | "blocked" | "not-applicable";

export interface DshSeamInfo {
  /** DSH 侧的 ctx.<name>。 */
  seam: string;
  /** Pi Studio 对应的实现（能力名或原生机制）。 */
  pi: string;
  /** 当前适配状态。 */
  status: DshSeamStatus;
}

export interface DshAdaptationReport {
  package: string;
  version: string | null;
  /** 是否可以安装并经 DSH adapter 进入 Pi Studio。 */
  adaptable: boolean;
  /** 0-100。 */
  score: number;
  /** 不通过时给用户的简短原因。 */
  reason: string;
  /** 检测到的 seam 使用情况。 */
  seams: DshSeamInfo[];
  /** 插件实际用到的 seam（源码扫描 + inject 声明）。 */
  usedSeams: string[];
  /** 该插件提供的可见能力（tools / skills / client-ui / host）。 */
  capabilities: string[];
  notes: string[];
}

/** 已由 Pi 宿主实现的 DSH seam。 */
const MAPPED_SEAMS: Record<string, string> = {
  fs: "Pi 文件能力（允许根 + 原子写）",
  tools: "Pi Agent 工具注册表",
  systemPrompt: "Pi system prompt 段落",
  skills: "Pi 技能注册表（skills-service）",
  browser: "Pi 右侧浏览器 / Semantic Browser V2",
  storage: "Pi 数据目录（storage-config）",
  credentials: "Pi auth.json / provider-credential-store",
};

/** DSH 宿主自身的能力 seam：安装后相当于替换宿主，Pi 一律不安装。 */
const HOST_SEAMS: Record<string, string> = {
  agentLoop: "宿主 agent loop",
  llm: "宿主 LLM 注册表",
  session: "宿主会话运行时",
  sessionPersistence: "宿主会话持久化",
  subprocess: "宿主子进程",
  terminal: "宿主终端",
  sandbox: "宿主沙箱",
  sandboxPolicy: "宿主沙箱策略",
  approval: "宿主审批",
  permission: "宿主权限",
  git: "宿主 Git 能力",
  compaction: "宿主压缩",
  tokenMeter: "宿主 token 计量",
  attachment: "宿主附件存储",
  attachmentLocal: "宿主附件存储",
  webServer: "宿主 Web 服务",
};

/**
 * client 侧 seam（浏览器端 Cordis 服务）：由 DSH client adapter 映射到 Pi，
 * 不阻塞安装（Pi UI Extension Point / client adapter 已落地）。
 * 映射详情见 dsh-client-contract.ts 的 DSH_CLIENT_SEAM_MAP。
 */
const CLIENT_SEAMS: Record<string, string> = {
  slots: "Pi UI 扩展点（ActivityBar rail / panel）",
  sessions: "Pi 会话存储（/api/sessions）",
  workspaces: "Pi 工作区（/api/worktrees）",
  workspaceRegistry: "Pi 工作区注册表",
  connection: "Pi Runtime 连接（/api/* RPC）",
  settings: "Pi 设置（settings.json）",
  settingsScope: "Pi 设置（settings.json）",
  locale: "Pi i18n（lib/i18n）",
  ui: "Pi UI 扩展点",
  commands: "Pi 命令面板",
  theme: "Pi 主题",
  remote: "Pi Remote/IPC（Electron bridge）",
  webUiSettings: "Pi 设置（settings.json）",
};

/** 宿主侧尚未映射的 Pi 能力（Phase 3）：检测到说明当前还无适配器，仍阻塞。 */
const PENDING_SEAMS: Record<string, string> = {
  subagent: "Pi 子代理（Phase 3）",
  goal: "Pi 目标管理（Phase 3）",
  tasks: "Pi 任务（Phase 3）",
  workflow: "Pi 工作流（Phase 3）",
};

/** 与适配器无关、不影响安装判断的 DSH 内部行。 */
const NOT_APPLICABLE_SEAMS = new Set([
  "timer",
  "hmr",
  "userInteraction",
  "brand",
  "typert",
  "telemetryOtel",
  "spillPolicy",
  "timeoutPolicy",
  "commandFeedback",
]);

/** 所有 DSH seam 名（含文档中出现但不在契约服务列表里的 UI seam）。 */
const ALL_KNOWN_SEAMS = new Set([
  ...Object.keys(MAPPED_SEAMS),
  ...Object.keys(HOST_SEAMS),
  ...Object.keys(CLIENT_SEAMS),
  ...Object.keys(PENDING_SEAMS),
  ...NOT_APPLICABLE_SEAMS,
  "skills",
  "tools",
  "fs",
  "systemPrompt",
  "browser",
  "storage",
  "credentials",
  "agentLoop",
  "llm",
  "session",
  "sessionPersistence",
  "subprocess",
  "terminal",
  "sandbox",
  "sandboxPolicy",
  "approval",
  "permission",
  "git",
  "compaction",
  "tokenMeter",
  "attachment",
  "attachmentLocal",
  "webServer",
  "remote",
  "sessions",
  "workspaces",
  "workspaceRegistry",
  "connection",
  "settings",
  "settingsScope",
  "locale",
  "slots",
  "ui",
  "commands",
  "theme",
  "subagent",
  "goal",
  "tasks",
  "workflow",
  "timer",
  "hmr",
  "userInteraction",
  "brand",
  "typert",
  "telemetryOtel",
  "spillPolicy",
  "timeoutPolicy",
  "commandFeedback",
]);

/** 宿主核心包名：这些包是 DSH 运行时自身，不是插件。 */
const HOST_PACKAGE_RE =
  /^@deepseek-ai\/cordis(-|$)|^@deepseek-ai\/dsh-agent(-|$)|^@deepseek-ai\/dsh(-|$)/;

/** 宿主能力包：不是插件，而是 DSH 运行时能力（Pi 已内建，拒绝安装）。 */
const HOST_CAPABILITY_RE = /^@deepseek-ai\/dsh-(llm|session|sandbox|subprocess|fs|tools|system-prompt|skills|agent-loop|compaction|credentials|storage|token-meter|attachment)(-|$)/;

interface NpmPackageMeta {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  dsh?: DshPackageManifest & {
    client?: { platform?: string; entry?: string };
  };
}

function npmUrl(name: string): string {
  return `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
}

function unpkgUrl(name: string, file: string): string {
  const clean = file.replace(/^\.\//, "");
  return `https://unpkg.com/${name}/${clean}`;
}

async function fetchNpmMeta(name: string): Promise<NpmPackageMeta | null> {
  try {
    const res = await fetch(npmUrl(name), {
      headers: { "User-Agent": "pi-studio/0.8 (dsh detect)", Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      "dist-tags"?: { latest?: string };
      versions?: Record<string, NpmPackageMeta>;
    };
    const latest = json["dist-tags"]?.latest;
    return latest ? (json.versions?.[latest] ?? null) : null;
  } catch {
    return null;
  }
}

async function fetchSource(name: string, file: string): Promise<string | null> {
  if (!file) return null;
  try {
    const res = await fetch(unpkgUrl(name, file), {
      headers: { "User-Agent": "pi-studio/0.8 (dsh detect)", Accept: "*/*" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 256_000 ? text.slice(0, 256_000) : text;
  } catch {
    return null;
  }
}

function entryFilesOf(meta: NpmPackageMeta): { host: string[]; client: string[] } {
  const host: string[] = [];
  const client: string[] = [];
  const dot = meta.exports?.["."];
  if (typeof dot === "string") {
    host.push(dot);
  } else if (dot && typeof dot === "object") {
    const map = dot as Record<string, unknown>;
    for (const key of ["default", "import", "require", "node", "browser"]) {
      const v = map[key];
      if (typeof v === "string") host.push(v);
    }
  }
  if (meta.module) host.push(meta.module);
  if (meta.main) host.push(meta.main);
  if (meta.dsh?.client?.entry) client.push(meta.dsh.client.entry);
  const clientExport = meta.exports?.["./client"];
  if (typeof clientExport === "string") client.push(clientExport);
  else if (clientExport && typeof clientExport === "object") {
    for (const v of Object.values(clientExport as Record<string, unknown>)) {
      if (typeof v === "string") client.push(v);
    }
  }
  return { host: [...new Set(host)], client: [...new Set(client)] };
}

function hasClientExports(meta: NpmPackageMeta): boolean {
  return Boolean(meta.dsh?.client || meta.exports?.["./client"]);
}

const CTX_PROP_RE = /\bctx\.([A-Za-z][A-Za-z0-9_]*)\b/g;
const CTX_GET_RE = /\bctx\.(?:get|require)\(["']([A-Za-z][A-Za-z0-9_]*)["']\)/g;
const INJECT_LITERAL_RE = /inject\s*[:=]\s*\[([\s\S]*?)\]/;

function scanSeams(source: string, out: Set<string>): void {
  for (const re of [CTX_PROP_RE, CTX_GET_RE]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const seam = m[1];
      if (ALL_KNOWN_SEAMS.has(seam)) out.add(seam);
    }
  }
  // 客户端插件的 slots/UI 注册通常走 ctx.slots / ctx.ui.inject 等。
  if (/\bctx\.slots\b|\bctx\.ui\b/.test(source)) {
    out.add(/\bctx\.slots\b/.test(source) ? "slots" : "ui");
  }
}

/** 从入口源码解析插件声明的 `inject: ["service", ...]` 字面量。 */
function parseInjectDeclaration(source: string): string[] {
  const m = source.match(INJECT_LITERAL_RE);
  if (!m) return [];
  const out: string[] = [];
  const strRe = /["']([A-Za-z][A-Za-z0-9_]*)["']/g;
  let sm: RegExpExecArray | null;
  while ((sm = strRe.exec(m[1])) !== null) out.push(sm[1]);
  return [...new Set(out)];
}

function seamInfo(seam: string, kind: "host" | "client"): DshSeamInfo {
  if (kind === "client") {
    // client 语境：同名 seam（如 sessions）映射到 Pi 客户端存储，非宿主运行时。
    if (CLIENT_SEAMS[seam]) return { seam, pi: CLIENT_SEAMS[seam], status: "client" };
    if (MAPPED_SEAMS[seam]) return { seam, pi: MAPPED_SEAMS[seam], status: "mapped" };
    if (HOST_SEAMS[seam]) return { seam, pi: HOST_SEAMS[seam], status: "blocked" };
    if (PENDING_SEAMS[seam]) return { seam, pi: PENDING_SEAMS[seam], status: "pending" };
    return { seam, pi: "DSH 内部实现", status: "not-applicable" };
  }
  if (MAPPED_SEAMS[seam]) return { seam, pi: MAPPED_SEAMS[seam], status: "mapped" };
  if (HOST_SEAMS[seam]) return { seam, pi: HOST_SEAMS[seam], status: "blocked" };
  if (PENDING_SEAMS[seam]) return { seam, pi: PENDING_SEAMS[seam], status: "pending" };
  return { seam, pi: "DSH 内部实现", status: "not-applicable" };
}

function defaultReport(pkg: string, reason: string, notes: string[]): DshAdaptationReport {
  return {
    package: pkg,
    version: null,
    adaptable: false,
    score: 0,
    reason,
    seams: [],
    usedSeams: [],
    capabilities: [],
    notes,
  };
}

/**
 * 对一个 npm 包做适配检测。
 *
 * 判定原则（host / client 分语境）：
 *   - DSH 宿主包 → 拒绝
 *   - host 侧（exports["."]）inject 宿主 seam（agentLoop/webServer/sandbox…）→ host 侧不桥接，但不阻断 client 侧
 *   - client 侧（exports["./client"]）inject 宿主 seam → client 侧拒绝
 *   - 双面插件（host 有宿主 seam + client 只有 client seam，如 dsh-better-sidebar）→ 以 client 侧安装
 *   - 只依赖已映射 seam（fs/tools/systemPrompt/skills）→ host 侧桥接
 */
export async function detectDshPackage(pkg: string): Promise<DshAdaptationReport> {
  const safe = pkg.trim();
  if (!safe || !/^[\w@./-]+$/.test(safe)) {
    return defaultReport(pkg, "无效的包名", ["package name rejected"]);
  }
  const meta = await fetchNpmMeta(safe);
  if (!meta) {
    return defaultReport(pkg, "npm registry 未找到该包", ["registry lookup failed"]);
  }

  const used = new Set<string>();
  const { host: hostFiles, client: clientFiles } = entryFilesOf(meta);
  const hostSources = await Promise.all(hostFiles.slice(0, 8).map((f) => fetchSource(safe, f)));
  const clientSources = await Promise.all(clientFiles.slice(0, 8).map((f) => fetchSource(safe, f)));

  // 分语境收集 inject 声明：host 入口（exports["."]）与 client 入口
  // （exports["./client"]）分别判定。同一 seam 名在两侧语义不同
  // （如 sessions：host 语境=宿主会话运行时 blocked，client 语境=Pi 会话存储 client）。
  const hostInject = new Set<string>();
  const clientInject = new Set<string>();
  for (const src of hostSources) {
    if (src) {
      for (const seam of parseInjectDeclaration(src)) hostInject.add(seam);
      scanSeams(src, used);
    }
  }
  for (const src of clientSources) {
    if (src) {
      for (const seam of parseInjectDeclaration(src)) clientInject.add(seam);
      scanSeams(src, used);
    }
  }

  const dshPeers = Object.keys({ ...(meta.peerDependencies ?? {}) }).filter((d) =>
    d.startsWith("@deepseek-ai/"),
  );
  const hasDshEntry =
    hostSources.some((s) => Boolean(s && (s.includes("apply") || s.includes("ctx.plugin")))) ||
    clientSources.some((s) => Boolean(s && (s.includes("apply") || s.includes("ctx.plugin")))) ||
    dshPeers.includes("@deepseek-ai/cordis") ||
    dshPeers.includes("@deepseek-ai/dsh-agent");
  const hostCapabilityPackage = HOST_CAPABILITY_RE.test(safe);

  const ordered = [...used].sort();
  const hostSeams = [...hostInject].sort().map((s) => seamInfo(s, "host"));
  const clientSeams = [...clientInject].sort().map((s) => seamInfo(s, "client"));
  const capabilities: string[] = [];
  if (ordered.includes("tools")) capabilities.push("tools");
  if (ordered.includes("skills")) capabilities.push("skills");
  if (ordered.includes("systemPrompt")) capabilities.push("system-prompt");
  if (hasClientExports(meta)) capabilities.push("client-ui");
  if (meta.dsh?.bundle?.patch) capabilities.push("bundle");
  if (capabilities.length === 0 && (hostSources.some(Boolean) || clientSources.some(Boolean))) {
    capabilities.push("host");
  }

  const isHostPackage =
    hostCapabilityPackage || (HOST_PACKAGE_RE.test(safe) && !/dsh-tool|dsh-skill/.test(safe));

  // host 侧判定（host 入口 inject）：blocked/pending 只影响 host 侧桥接，不阻断 client 侧。
  const hostBlocked = hostSeams.filter((s) => s.status === "blocked");
  const hostPending = hostSeams.filter((s) => s.status === "pending");
  const hostMapped = hostSeams.filter((s) => s.status === "mapped");
  // client 侧判定（client 入口 inject）：blocked/pending 阻断 client 侧。
  const clientBlocked = clientSeams.filter((s) => s.status === "blocked");
  const clientPending = clientSeams.filter((s) => s.status === "pending");

  const hostBridgeable =
    hostBlocked.length === 0 &&
    hostPending.length === 0 &&
    (hostMapped.length > 0 || capabilities.includes("tools") || capabilities.includes("skills"));
  const clientInstallable =
    hasClientExports(meta) && clientBlocked.length === 0 && clientPending.length === 0;

  let score = 100;
  const notes: string[] = [];
  const reasonParts: string[] = [];
  if (isHostPackage) {
    score = 0;
    reasonParts.push("这是 DSH 宿主包，不是插件，不应安装进 Pi Studio");
  }
  if (hostBlocked.length > 0) {
    score = Math.max(0, score - hostBlocked.length * 30);
    notes.push(`host seam blocked（host 侧不桥接）: ${hostBlocked.map((s) => s.seam).join(", ")}`);
  }
  if (clientBlocked.length > 0) {
    score = Math.max(0, score - clientBlocked.length * 30);
    reasonParts.push(`client 依赖宿主 seam：${clientBlocked.map((s) => s.seam).join(", ")}`);
  }
  if (hostPending.length > 0) {
    score = Math.max(0, score - hostPending.length * 25);
    reasonParts.push(`需要尚未落地的 Pi 能力（host）：${hostPending.map((s) => s.seam).join(", ")}`);
    notes.push(`pending host pi adapter: ${hostPending.map((s) => s.seam).join(", ")}`);
  }
  if (clientPending.length > 0) {
    score = Math.max(0, score - clientPending.length * 25);
    reasonParts.push(`需要尚未落地的 Pi 能力（client）：${clientPending.map((s) => s.seam).join(", ")}`);
  }
  const clientOnlySeams = clientSeams.filter((s) => s.status === "client");
  if (clientOnlySeams.length > 0) {
    notes.push(`client seam (via client adapter): ${clientOnlySeams.map((s) => s.seam).join(", ")}`);
  }
  if (hasClientExports(meta) && clientInstallable) {
    notes.push("client-ui plugin; UI rendered via dsh-client-adapter (Pi UI Extension Point)");
  }
  if (!hostBridgeable && !clientInstallable && !isHostPackage && hostBlocked.length === 0 && clientBlocked.length === 0) {
    score = Math.max(0, score - 40);
    reasonParts.push(
      hasDshEntry
        ? "未检测到可桥接的 tools/skills 或可安装的 client 入口"
        : "未识别出 DSH 插件入口（缺 apply / cordis 依赖），不是可直接适配的插件",
    );
    notes.push(hasDshEntry ? "no bridgeable capability detected" : "no dsh plugin entry detected");
  }
  if (capabilities.length === 0) {
    notes.push("no known capability markers found");
  }

  notes.push(
    `entry files scanned: ${[...hostFiles, ...clientFiles].slice(0, 8).join(", ") || "none"}`,
    `seams used: ${ordered.join(", ") || "none"}`,
  );
  const declared = new Set([...hostInject, ...clientInject]);
  const lazy = ordered.filter((s) => !declared.has(s));
  if (lazy.length > 0) {
    notes.push(`lazy/optional refs (not inject): ${lazy.join(", ")}`);
  }

  const adaptable = !isHostPackage && (hostBridgeable || clientInstallable);

  // 合并 host/client seam（同名时 client 语境优先，如 sessions）。
  const seamByName = new Map<string, DshSeamInfo>();
  for (const s of [...hostSeams, ...clientSeams]) seamByName.set(s.seam, s);

  return {
    package: safe,
    version: meta.version ?? null,
    adaptable,
    score,
    reason: adaptable
      ? "可经 DSH Adapter 安装到 Pi Studio"
      : reasonParts.join("；") || "无法适配到 Pi Studio",
    seams: [...seamByName.values()],
    usedSeams: ordered,
    capabilities: [...new Set(capabilities)],
    notes: notes.slice(0, 10),
  };
}
