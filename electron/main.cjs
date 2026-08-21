"use strict";

/**
 * Pi Studio 桌面应用主进程（Electron）。
 *
 * 职责：
 *  1. 用本 exe 自带的 Node（ELECTRON_RUN_AS_NODE=1）启动内置的 Next.js 服务
 *     （next start，随机空闲端口，只监听 127.0.0.1）；
 *  2. 解析服务就绪后的实际端口，打开 BrowserWindow 加载该地址；
 *  3. 退出时结束服务子进程（含其 worker 树）。
 *
 * 环境变量（均可选）：
 *  - PI_WEB_PORT       固定端口（默认 0 = 随机空闲端口，自动探测）
 *  - PI_WEB_DIST_DIR   Next 构建目录（默认 .next-pkg，与 scripts/package.mjs 一致）
 *  - PI_WEB_UPLOADS_DIR         数据目录显式覆盖（最高优先级，可选）
 *  - PI_WEB_UPLOADS_DEFAULT_DIR 数据目录默认值（内部：userData/pi-web-uploads，可写；
 *                               用户可在 UI「修改目录」覆盖此默认值）
 */

// Electron npm 包 index.js 只导出 exe 路径字符串，会遮蔽 Electron 内置 API 模块。
// 临时重命名 index.js 和 package.json 让 require("electron") 回退到内置模块。
(function () {
  const path = require("path");
  const fs = require("fs");
  const dir = path.join(__dirname, "..", "node_modules", "electron");
  const indexJs = path.join(dir, "index.js");
  const indexBak = indexJs + ".pi-bak";
  const pkgJson = path.join(dir, "package.json");
  const pkgBak = pkgJson + ".pi-bak";
  try { if (fs.existsSync(indexJs)) fs.renameSync(indexJs, indexBak); } catch {}
  try { if (fs.existsSync(pkgJson)) fs.renameSync(pkgJson, pkgBak); } catch {}
  globalThis.__piElectronRestore = () => {
    try { if (fs.existsSync(indexBak)) fs.renameSync(indexBak, indexJs); } catch {}
    try { if (fs.existsSync(pkgBak)) fs.renameSync(pkgBak, pkgJson); } catch {}
  };
})();

const { app, BrowserWindow, dialog, ipcMain, Menu, shell, WebContentsView } = require("electron");

// require 完成后立即恢复（后续不再需要内置模块解析）
if (globalThis.__piElectronRestore) { globalThis.__piElectronRestore(); globalThis.__piElectronRestore = undefined; }
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const { startBridge } = require("./bridge.cjs");
const PRELOAD = path.join(__dirname, "preload.cjs");

const APP_ROOT = path.join(__dirname, "..");
const DIST_DIR = process.env.PI_WEB_DIST_DIR || ".next-pkg";
const SERVER_MODE = process.env.PI_WEB_SERVER_MODE === "dev" ? "dev" : "start";
const HOST = "127.0.0.1";
const PORT = process.env.PI_WEB_PORT || (SERVER_MODE === "dev" ? "10141" : "0");

let serverProc = null;
let mainWindow = null;
let quitForReal = false;
let bridgeServer = null;
let bridgeBaseUrl = null;
let browserDownloadsDir = null;

// 原生右侧浏览器：每个网页标签一个 WebContentsView，只有一个可见。
const webViews = new Map();
const pendingWebViewState = new Map();
let activeWebViewTabId = null;
let lastWebViewBounds = null;
let downloadHandlerRegistered = false;
const recentBrowserDownloads = [];

app.setName("Pi Studio");

// 开发版（npm run dev:electron）必须用独立的 userData，不能与已安装的桌面版共用 %APPDATA%/Pi Studio：
// 两者都会 setName("Pi Studio")，userData 按 app 名惰性解析后落到同一目录，导致：
//   1. 单实例锁互相冲突 —— exe 版在运行时，dev 版 requestSingleInstanceLock() 返回 false，app.quit() 假死；
//   2. 数据目录（open-file 标记 / user-edits / univer home / 上传）被两边同时读写、互相污染。
// 注意顺序：必须 setPath 在 setName 之后（首次访问 getPath 会缓存路径，setName 会改写它）。
if (SERVER_MODE === "dev") {
  app.setPath("userData", path.join(app.getPath("appData"), "Pi Studio Dev"));
}

// CDP 远程调试端口：让 agent 能直接操作右侧 WebContentsView（点击/输入/截图）。
// 默认 9222（仅监听 127.0.0.1）；可用 PI_WEB_CDP_PORT 改端口，设为 0 关闭。
const cdpPort = process.env.PI_WEB_CDP_PORT;
if (cdpPort === undefined || cdpPort !== "0") {
  app.commandLine.appendSwitch("remote-debugging-port", cdpPort || "9222");
}

// ---------------------------------------------------------------------------
// 服务启动
// ---------------------------------------------------------------------------

function resolveNextBin() {
  try {
    return require.resolve("next/dist/bin/next", { paths: [APP_ROOT] });
  } catch {
    return path.join(APP_ROOT, "node_modules", "next", "dist", "bin", "next");
  }
}

function startServer(extraEnv = {}) {
  const buildDir = path.join(APP_ROOT, DIST_DIR);
  if (SERVER_MODE !== "dev" && !fs.existsSync(buildDir)) {
    dialog.showErrorBox(
      "Pi Studio 启动失败",
      `未找到前端构建产物：\n${buildDir}\n\n请先在项目目录运行：\nnpm run pack:dir\n\n或运行 npm run dev 后用浏览器访问。`,
    );
    app.quit();
    return null;
  }

  const nextBin = resolveNextBin();
  const nextCommand = SERVER_MODE === "dev" ? "dev" : "start";
  const child = spawn(
    process.execPath, // 打包后即本 exe；配合 ELECTRON_RUN_AS_NODE=1 以纯 Node 方式运行
    [nextBin, nextCommand, "-p", PORT, "-H", HOST],
    {
      cwd: APP_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...extraEnv,
        ELECTRON_RUN_AS_NODE: "1", // 关键：让 exe 扮演 node；子进程（含 univer daemon）会继承
        PI_WEB_DIST_DIR: DIST_DIR,
        PI_WEB_HOSTNAME: HOST,
        PI_WEB_NO_OPEN: "1", // 不弹系统默认浏览器
        // 数据目录放到用户可写的位置（安装到 Program Files 时项目目录不可写）
        PI_WEB_UPLOADS_DEFAULT_DIR:
          extraEnv.PI_WEB_UPLOADS_DEFAULT_DIR || path.join(app.getPath("userData"), "pi-web-uploads"),
      },
    },
  );

  child.stderr.on("data", (chunk) => process.stderr.write(`[next] ${chunk}`));
  child.on("exit", (code, signal) => {
    console.log(`[pi-studio] server exited: code=${code} signal=${signal}`);
    if (!quitForReal) {
      dialog.showErrorBox("Pi Studio 服务已停止", `内置服务异常退出（code=${code ?? signal}），应用将关闭。`);
      app.quit();
    }
  });

  return child;
}

/** 从 next start 的输出中解析实际监听端口（-p 0 时为随机端口）。 */
function waitForServerUrl(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error("等待服务启动超时（60s）"));
    }, 60_000);

    const onData = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[next] ${text}`);
      const m = /http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(text);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(`http://${HOST}:${m[1]}`);
      }
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`服务进程提前退出（code=${code}）`));
      }
    });
  });
}

/** 轮询直到服务可以响应（构建产物是预编译的，通常 1~3 秒内就绪）。 */
function waitForReady(url, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve(true);
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(3000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error("服务就绪检测超时"));
      else setTimeout(ping, 500);
    };
    ping();
  });
}

function killServer() {
  if (!serverProc || serverProc.killed) return;
  if (process.platform === "win32") {
    // Kill the whole tree FIRST. taskkill /T terminates the server together
    // with all its children (next dev 的 Turbopack worker、next start 的子进程等)
    // atomically. If we killed the parent first, the children would be
    // reparented to the system and /T could no longer reach them — leaving
    // orphaned node.exe processes behind after the window closes.
    try {
      spawnSync("taskkill", ["/PID", String(serverProc.pid), "/T", "/F"], { windowsHide: true, timeout: 8000 });
    } catch {
      /* ignore */
    }
  }
  try {
    serverProc.kill();
  } catch {
    /* ignore */
  }
}

/**
 * Kill pi-studio's own univer daemon on exit.
 *
 * The daemon is started detached (`univer daemon start` spawns `daemon.js serve`
 * as a separate process, reparented away from the next server), so it survives
 * killServer()'s process-tree kill and would keep running after the app closes.
 * The daemon writes its pid at startup to
 * `<dataDir>/.internal/univer/daemon/daemon.pid` (UNIVER_HOME/daemon, see
 * lib/univer-cli.ts / lib/storage-config.ts) — read it and hard-kill the tree,
 * so closing the app leaves no services behind.
 */
function killUniverDaemon() {
  let pid;
  try {
    const pidFile = path.join(resolveDataDir(), ".internal", "univer", "daemon", "daemon.pid");
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return; // no pid file — nothing to kill
  }
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000 });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* already dead */
  }
}

// ---------------------------------------------------------------------------
// 原生右侧浏览器（WebContentsView + IPC + 控制桥）
// ---------------------------------------------------------------------------

function getActiveViewContents() {
  if (activeWebViewTabId) {
    const view = webViews.get(activeWebViewTabId);
    if (view && !view.webContents.isDestroyed()) return view.webContents;
  }
  for (const view of webViews.values()) {
    if (!view.webContents.isDestroyed()) return view.webContents;
  }
  return null;
}

function notifyWebView(tabId, navigated = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const view = webViews.get(tabId);
  if (!view || view.webContents.isDestroyed()) return;
  const info = {
    tabId,
    url: view.webContents.getURL() || null,
    title: view.webContents.getTitle() || null,
  };
  mainWindow.webContents.send(navigated ? "pi-webview-navigated" : "pi-webview-status", info);
}

function sanitizeDownloadFileName(name) {
  const fallback = "download";
  const cleaned = String(name || fallback).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
  return cleaned || fallback;
}

function uniqueDownloadPath(fileName) {
  const dir = browserDownloadsDir;
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const safeName = sanitizeDownloadFileName(fileName);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  let candidate = path.join(dir, safeName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

function rememberDownload(record) {
  recentBrowserDownloads.unshift(record);
  recentBrowserDownloads.splice(20);
}

function registerDownloadHandler(view) {
  if (downloadHandlerRegistered || !browserDownloadsDir) return;
  downloadHandlerRegistered = true;
  view.webContents.session.on("will-download", (_event, item, webContents) => {
    const filePath = uniqueDownloadPath(item.getFilename());
    if (!filePath) return;
    item.setSavePath(filePath);
    const record = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      filePath,
      fileName: path.basename(filePath),
      url: item.getURL() || webContents.getURL() || null,
      state: "progressing",
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    rememberDownload(record);
    item.on("updated", (_event, state) => {
      record.state = state;
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.updatedAt = new Date().toISOString();
    });
    item.once("done", (_event, state) => {
      record.state = state;
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.updatedAt = new Date().toISOString();
    });
  });
}

function getRecentBrowserDownloads() {
  return recentBrowserDownloads;
}

function createWebView(tabId) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  if (webViews.has(tabId)) return webViews.get(tabId);
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:pi-web-browser",
      spellcheck: true,
    },
  });
  view.setBackgroundColor("#ffffff");
  registerDownloadHandler(view);
  // target=_blank 弹窗直接在当前原生视图里打开，避免脱离右侧面板。
  view.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        view.webContents.loadURL(parsed.href);
      } else {
        void shell.openExternal(url);
      }
    } catch {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  const onNavigated = () => notifyWebView(tabId, true);
  view.webContents.on("did-navigate", onNavigated);
  view.webContents.on("did-navigate-in-page", onNavigated);
  view.webContents.on("page-title-updated", () => notifyWebView(tabId));
  mainWindow.contentView.addChildView(view);
  webViews.set(tabId, view);
  try {
    view.setVisible(false);
  } catch {
    /* older Electron API — hide via removeChildView below */
  }
  const pending = pendingWebViewState.get(tabId);
  if (pending) {
    if (pending.bounds) setWebViewBounds(tabId, pending.bounds);
    if (typeof pending.visible === "boolean") setWebViewVisible(tabId, pending.visible);
    pendingWebViewState.delete(tabId);
  }
  return view;
}

function destroyWebView(tabId) {
  const view = webViews.get(tabId);
  if (!view) return;
  try {
    mainWindow?.contentView.removeChildView(view);
  } catch {
    /* already removed */
  }
  try {
    view.webContents.close();
  } catch {
    /* best-effort */
  }
  webViews.delete(tabId);
  if (activeWebViewTabId === tabId) activeWebViewTabId = null;
}

function setWebViewVisible(tabId, visible) {
  const view = webViews.get(tabId);
  if (!view) {
    const pending = pendingWebViewState.get(tabId) || {};
    pending.visible = visible;
    pendingWebViewState.set(tabId, pending);
    return;
  }
  if (visible) activeWebViewTabId = tabId;
  for (const [id, candidate] of webViews) {
    if (id === tabId) continue;
    try {
      candidate.setVisible(false);
    } catch {
      try {
        mainWindow?.contentView.removeChildView(candidate);
      } catch {
        /* best-effort */
      }
    }
  }
  try {
    view.setVisible(visible);
  } catch {
    if (visible) {
      try {
        mainWindow?.contentView.addChildView(view);
      } catch {
        /* best-effort */
      }
    } else {
      try {
        mainWindow?.contentView.removeChildView(view);
      } catch {
        /* best-effort */
      }
    }
  }
  if (visible && lastWebViewBounds) {
    try {
      view.setBounds(lastWebViewBounds);
    } catch {
      /* best-effort */
    }
  }
}

function setWebViewBounds(tabId, bounds) {
  if (!bounds || typeof bounds.x !== "number" || typeof bounds.y !== "number") return;
  lastWebViewBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width || 0)),
    height: Math.max(0, Math.round(bounds.height || 0)),
  };
  const view = webViews.get(tabId);
  if (!view) {
    const pending = pendingWebViewState.get(tabId) || {};
    pending.bounds = lastWebViewBounds;
    pendingWebViewState.set(tabId, pending);
    return;
  }
  try {
    view.setBounds(lastWebViewBounds);
  } catch {
    /* best-effort */
  }
}

function registerWebViewIpc() {
  ipcMain.handle("pi-webview-create", (_event, tabId) => {
    createWebView(String(tabId));
  });
  ipcMain.handle("pi-webview-destroy", (_event, tabId) => {
    destroyWebView(String(tabId));
  });
  ipcMain.on("pi-webview-visible", (_event, tabId, visible) => {
    setWebViewVisible(String(tabId), Boolean(visible));
  });
  ipcMain.on("pi-webview-bounds", (_event, tabId, bounds) => {
    setWebViewBounds(String(tabId), bounds);
  });
  ipcMain.handle("pi-webview-navigate", async (_event, tabId, rawUrl) => {
    const id = String(tabId);
    const view = webViews.get(id) || createWebView(id);
    if (!view) throw new Error("webview not created");
    const target = new URL(String(rawUrl || ""));
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("Only http(s) URLs are supported");
    await view.webContents.loadURL(target.href);
    return {
      url: view.webContents.getURL() || null,
      title: view.webContents.getTitle() || null,
    };
  });
  ipcMain.handle("pi-webview-back", async (_event, tabId) => {
    const view = webViews.get(String(tabId));
    if (!view || !view.webContents.canGoBack()) return { moved: false };
    view.webContents.goBack();
    return { moved: true };
  });
  ipcMain.handle("pi-webview-forward", async (_event, tabId) => {
    const view = webViews.get(String(tabId));
    if (!view || !view.webContents.canGoForward()) return { moved: false };
    view.webContents.goForward();
    return { moved: true };
  });
  ipcMain.handle("pi-webview-reload", async (_event, tabId) => {
    const view = webViews.get(String(tabId));
    if (!view) return { ok: false };
    view.webContents.reload();
    return { ok: true };
  });
  ipcMain.handle("pi-webview-info", async (_event, tabId) => {
    const view = webViews.get(String(tabId));
    if (!view) return { url: null, title: null };
    return {
      url: view.webContents.getURL() || null,
      title: view.webContents.getTitle() || null,
    };
  });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: "#0d0d0d",
    title: "Pi Studio",
    // 自定义窗口：无原生标题栏/菜单栏（titleBarStyle:"hidden" 保留原生缩放边缘，
    // titleBarOverlay:false 不叠加原生窗口按钮），窗口控制（— □ ×）由网页里的
    // WindowControls 组件实现（见 pi-window-minimize / -maximize-toggle / -close IPC）。
    titleBarStyle: "hidden",
    titleBarOverlay: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  // 最大化状态变化 → 通知渲染进程（WindowControls 切换 □/❐ 图标）。
  mainWindow.on("maximize", () => {
    if (!mainWindow?.isDestroyed()) mainWindow.webContents.send("pi-window-maximized", true);
  });
  mainWindow.on("unmaximize", () => {
    if (!mainWindow?.isDestroyed()) mainWindow.webContents.send("pi-window-maximized", false);
  });
  mainWindow.on("closed", () => {
    for (const tabId of Array.from(webViews.keys())) destroyWebView(tabId);
    webViews.clear();
    activeWebViewTabId = null;
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // 无原生菜单后，重新注册几个常用快捷键（开发者工具/刷新/全屏）。
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    if (input.key === "F12" || (ctrl && input.shift && input.key.toLowerCase() === "i")) {
      mainWindow?.webContents.toggleDevTools();
      event.preventDefault();
    } else if (ctrl && input.key.toLowerCase() === "r") {
      mainWindow?.webContents.reload();
      event.preventDefault();
    } else if (input.key === "F11") {
      mainWindow?.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    }
  });
  // 自定义窗口控制按钮（WindowControls 组件调用）。
  ipcMain.on("pi-window-minimize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.handle("pi-window-maximize-toggle", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle("pi-window-is-maximized", () => {
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized());
  });
  ipcMain.on("pi-window-close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  registerWebViewIpc();
  mainWindow.loadURL(url);
}

function buildMenu() {
  // 隐藏原生菜单栏（窗口控制见 WindowControls 组件；快捷键见 before-input-event）。
  Menu.setApplicationMenu(null);
}

function resolveDataDir() {
  // 显式覆盖（最高优先级，运维/部署用）
  const explicit = process.env.PI_WEB_UPLOADS_DIR?.trim();
  if (explicit) return explicit;
  // 用户配置（.pi-web-config.json）优先级高于 Electron 默认，与后端
  // lib/storage-config.ts 的解析顺序保持一致，保证浏览器下载目录 / univer daemon
  // 的位置与上传目录一致。
  try {
    const configPath = path.join(APP_ROOT, ".pi-web-config.json");
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const configured = parsed && typeof parsed.uploadsDir === "string" ? parsed.uploadsDir.trim() : "";
      if (configured) {
        return path.isAbsolute(configured) ? configured : path.resolve(APP_ROOT, configured);
      }
    }
  } catch {
    /* 配置损坏时回退默认 */
  }
  // Electron 默认（userData 可写位置）
  return path.join(app.getPath("userData"), "pi-web-uploads");
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("window-all-closed", () => app.quit());

  app.on("will-quit", () => {
    quitForReal = true;
    killServer();
    killUniverDaemon();
    if (bridgeServer) {
      try {
        bridgeServer.close();
      } catch {
        /* best-effort */
      }
      bridgeServer = null;
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    // 打开上传目录：用主进程（前台窗口）的 shell.openPath 打开，资源管理器窗口才能
    // 可靠地出现在前台。后端 POST /api/uploads?open=1 用后台进程 spawn explorer，
    // 会被 Windows 前台锁盖住（窗口开了但落在应用后面，用户以为“点了没反应”）。
    ipcMain.handle("pi-open-uploads-dir", async () => {
      try {
        const dir = resolveDataDir();
        const err = await shell.openPath(dir);
        return err ? { ok: false, error: String(err), dir } : { ok: true, dir };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    try {
      const dataDir = resolveDataDir();
      browserDownloadsDir = path.join(dataDir, "browser-downloads");
      let extraEnv = { PI_WEB_UPLOADS_DEFAULT_DIR: dataDir };
      try {
        const bridge = await startBridge({ getActiveView: getActiveViewContents, getDownloads: getRecentBrowserDownloads, dataDir });
        bridgeServer = bridge.server;
        bridgeBaseUrl = bridge.baseUrl;
        extraEnv.PI_WEB_BROWSER_BRIDGE_URL = bridgeBaseUrl;
      } catch (bridgeErr) {
        console.error("[pi-studio] 原生浏览器控制桥启动失败（右侧浏览器不可用）:", bridgeErr.message);
      }
      serverProc = startServer(extraEnv);
      if (!serverProc) return;
      const url = await waitForServerUrl(serverProc);
      await waitForReady(url);
      createWindow(url);
    } catch (err) {
      console.error("[pi-studio] 启动失败:", err.message);
      dialog.showErrorBox("Pi Studio 启动失败", String(err.message));
      app.quit();
    }
  });
}
