import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getInternalDir } from "@/lib/storage-config";
import { resolveNpmInvocation, resolveNodeExecutable } from "@/lib/npx";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";

// DSH Web UI 运行时：为「UI 插件」（面板/皮肤/桌宠等，node 侧 apply 为空、
// UI 在 exports["./client"] 且 dsh.client.platform=web）提供渲染宿主。
// 跑真实 `@deepseek-ai/dsh web`（完整 DSH Web UI），UI 插件经
// `dsh plugin --profile web add` 安装后由其前端自动加载显示。
// 与 tool/skill 桥接（lib/plugins/adapters/dsh）互补：那边桥接工具进 pi agent，
// 这边渲染 UI 面板进右面板。

const DSH_PACKAGE = process.env.PI_WEB_DSH_PACKAGE || "@deepseek-ai/dsh@0.1.0-rc.6";
const DSH_VERSION = DSH_PACKAGE.includes("@")
  ? DSH_PACKAGE.slice(DSH_PACKAGE.lastIndexOf("@") + 1)
  : "0.1.0-rc.6";

const RUNTIME_DIR = join(getInternalDir(), "dsh-ui-runtime");
const DSH_BIN = join(RUNTIME_DIR, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

export type DshUiStatus = "stopped" | "installing" | "starting" | "running" | "error";

export interface DshUiSnapshot {
  status: DshUiStatus;
  phase: string;
  url: string | null;
  port: number | null;
  error: string | null;
  installed: string[];
  bootLog: string;
}

interface DshUiState {
  status: DshUiStatus;
  phase: string;
  url: string | null;
  port: number | null;
  error: string | null;
  installed: string[];
  child: ChildProcess | null;
  startPromise: Promise<void> | null;
  bootLog: string;
}

const g = globalThis as unknown as { __dshUi?: DshUiState };

function initState(): DshUiState {
  if (!g.__dshUi) {
    g.__dshUi = {
      status: "stopped",
      phase: "",
      url: null,
      port: null,
      error: null,
      installed: loadInstalled(),
      child: null,
      startPromise: null,
      bootLog: "",
    };
  }
  return g.__dshUi;
}

function appendLog(s: DshUiState, chunk: string): void {
  s.bootLog = (s.bootLog + chunk).slice(-8000);
}

function dshHome(): string {
  const home = join(getInternalDir(), "dsh-ui-home");
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    // ignore
  }
  return home;
}

function installedFile(): string {
  return join(getInternalDir(), "pi-web-dsh-ui-plugins.json");
}

function loadInstalled(): string[] {
  try {
    if (!existsSync(installedFile())) return [];
    const parsed = JSON.parse(readFileSync(installedFile(), "utf8")) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // ignore
  }
  return [];
}

function saveInstalled(installed: string[]): void {
  try {
    writePrivateFileAtomicSync(installedFile(), JSON.stringify(installed, null, 2));
  } catch {
    // ignore
  }
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (res.ok || res.status < 500) return resolve(true);
      } catch {
        // not up yet
      }
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, 600);
    };
    void tick();
  });
}

function dshEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_HOME: dshHome(),
    DSH_TELEMETRY_DISABLED: "1",
    FORCE_COLOR: "0",
  };
}

function runtimeInstalled(): boolean {
  return existsSync(DSH_BIN);
}

/** dsh 生成的 pnpm-workspace.yaml 有 allowBuilds 占位符，翻转成 true 否则装不上。 */
function ensureAllowBuilds(): void {
  const wsFile = join(dshHome(), "profiles", "web", "pnpm-workspace.yaml");
  try {
    if (!existsSync(wsFile)) return;
    const content = readFileSync(wsFile, "utf8");
    const updated = content.replace(/[:\s]*(set this to true or false)/g, ": true");
    if (updated !== content) writeFileSync(wsFile, updated, "utf8");
  } catch {
    // ignore
  }
}

function installRuntime(s: DshUiState): Promise<boolean> {
  return new Promise((resolve) => {
    if (runtimeInstalled()) {
      resolve(true);
      return;
    }
    try {
      mkdirSync(RUNTIME_DIR, { recursive: true });
    } catch {
      // ignore
    }
    s.status = "installing";
    s.phase = "installing";
    appendLog(s, `[dsh-ui] installing ${DSH_PACKAGE} into ${RUNTIME_DIR} (first boot downloads deps)…\n`);
    const { command, commandArgs, useShell } = resolveNpmInvocation([
      "install",
      "--prefix",
      RUNTIME_DIR,
      DSH_PACKAGE,
      "--no-audit",
      "--no-fund",
      "--loglevel=info",
    ]);
    const child = spawn(command, commandArgs, {
      cwd: RUNTIME_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, 600_000);
    const onData = (buf: Buffer) => appendLog(s, buf.toString());
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(!timedOut && code === 0 && runtimeInstalled());
    });
  });
}

function spawnDshWeb(s: DshUiState, port: number): ChildProcess {
  const args = ["web", "--host", "127.0.0.1", "--port", String(port)];
  return spawn(resolveNodeExecutable(), [DSH_BIN, ...args], {
    env: dshEnv(),
    cwd: dshHome(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
}

export function getDshUiSnapshot(): DshUiSnapshot {
  const s = initState();
  return {
    status: s.status,
    phase: s.phase,
    url: s.url,
    port: s.port,
    error: s.error,
    installed: [...s.installed],
    bootLog: s.bootLog,
  };
}

export async function startDshUi(): Promise<DshUiSnapshot> {
  const s = initState();
  if (s.status === "running" && s.url) return getDshUiSnapshot();
  if (s.startPromise) {
    await s.startPromise;
    return getDshUiSnapshot();
  }

  s.startPromise = (async () => {
    s.error = null;
    try {
      const ok = await installRuntime(s);
      if (!ok) {
        s.status = "error";
        s.phase = "error";
        s.error = "dsh 运行时安装失败（见启动日志）";
        s.url = null;
        return;
      }

      s.status = "starting";
      s.phase = "booting";
      appendLog(s, "[dsh-ui] booting web profile…\n");
      const port = await pickFreePort();
      s.port = port;
      const child = spawnDshWeb(s, port);
      s.child = child;

      const onData = (buf: Buffer) => appendLog(s, buf.toString());
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("error", (err) => {
        if (s.child === child) {
          s.child = null;
          s.status = "error";
          s.phase = "error";
          s.error = `启动失败: ${err.message}`;
          s.url = null;
        }
      });
      child.once("exit", (code) => {
        if (s.child === child) {
          s.child = null;
          if (s.status !== "stopped") {
            s.status = "error";
            s.phase = "error";
            s.url = null;
            s.port = null;
            s.error = `dsh web 已退出 (code ${code ?? "?"})`;
          }
        }
      });

      const url = `http://127.0.0.1:${port}/`;
      const up = await waitForHttp(url, 300_000);
      if (!up) {
        s.status = "error";
        s.phase = "error";
        s.error = "dsh web 启动超时（见启动日志）";
        s.url = null;
        s.port = null;
        try { child.kill(); } catch { /* ignore */ }
        s.child = null;
        return;
      }
      s.status = "running";
      s.phase = "ready";
      s.url = url;
      s.installed = loadInstalled();
    } catch (e) {
      s.status = "error";
      s.phase = "error";
      s.error = e instanceof Error ? e.message : String(e);
      s.url = null;
      s.port = null;
      if (s.child) { try { s.child.kill(); } catch { /* ignore */ } s.child = null; }
    } finally {
      s.startPromise = null;
    }
  })();

  await s.startPromise;
  return getDshUiSnapshot();
}

export function stopDshUi(): DshUiSnapshot {
  const s = initState();
  s.status = "stopped";
  s.phase = "";
  s.url = null;
  s.port = null;
  s.error = null;
  if (s.child) {
    const child = s.child;
    s.child = null;
    try { child.kill(); } catch { /* ignore */ }
  }
  return getDshUiSnapshot();
}

/** 把一个 UI 插件装进 DSH Web UI 运行时（dsh plugin add）。 */
export async function installUiPlugin(pkg: string): Promise<{ ok: boolean; output: string }> {
  const safePkg = pkg.trim();
  if (!safePkg || !/^[\w@./-]+$/.test(safePkg)) return { ok: false, output: "invalid package name" };

  const s = initState();
  if (!runtimeInstalled()) {
    const ok = await installRuntime(s);
    if (!ok) return { ok: false, output: "dsh runtime not installed" };
  }
  ensureAllowBuilds();

  const args = ["plugin", "--profile", "web", "add", safePkg];
  return new Promise((resolve) => {
    const child = spawn(resolveNodeExecutable(), [DSH_BIN, ...args], {
      cwd: dshHome(),
      env: dshEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let out = "";
    const onData = (buf: Buffer) => {
      const text = buf.toString();
      out = (out + text).slice(-4000);
      appendLog(s, text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, output: "timeout" });
    }, 300_000);
    child.once("error", (err) => { clearTimeout(timer); resolve({ ok: false, output: err.message }); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const ok = code === 0;
      if (ok && !s.installed.includes(safePkg)) {
        s.installed = [...s.installed, safePkg];
        saveInstalled(s.installed);
      }
      resolve({ ok, output: out.slice(-2000) || `exit ${code ?? "?"}` });
    });
  });
}
