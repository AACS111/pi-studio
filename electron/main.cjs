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
 *  - PI_WEB_UPLOADS_DIR 数据目录（默认 %APPDATA%/Pi Studio/pi-web-uploads，可写）
 */

const { app, BrowserWindow, dialog, Menu } = require("electron");
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const APP_ROOT = path.join(__dirname, "..");
const DIST_DIR = process.env.PI_WEB_DIST_DIR || ".next-pkg";
const HOST = "127.0.0.1";
const PORT = process.env.PI_WEB_PORT || "0";

let serverProc = null;
let mainWindow = null;
let quitForReal = false;

app.setName("Pi Studio");

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

function startServer() {
  const buildDir = path.join(APP_ROOT, DIST_DIR);
  if (!fs.existsSync(buildDir)) {
    dialog.showErrorBox(
      "Pi Studio 启动失败",
      `未找到前端构建产物：\n${buildDir}\n\n请先在项目目录运行：\nnpm run pack:dir\n\n或运行 npm run dev 后用浏览器访问。`,
    );
    app.quit();
    return null;
  }

  const nextBin = resolveNextBin();
  const child = spawn(
    process.execPath, // 打包后即本 exe；配合 ELECTRON_RUN_AS_NODE=1 以纯 Node 方式运行
    [nextBin, "start", "-p", PORT, "-H", HOST],
    {
      cwd: APP_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1", // 关键：让 exe 扮演 node；子进程（含 univer daemon）会继承
        PI_WEB_DIST_DIR: DIST_DIR,
        PI_WEB_HOSTNAME: HOST,
        PI_WEB_NO_OPEN: "1", // 不弹系统默认浏览器
        // 数据目录放到用户可写的位置（安装到 Program Files 时项目目录不可写）
        PI_WEB_UPLOADS_DIR: path.join(app.getPath("userData"), "pi-web-uploads"),
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
  try {
    serverProc.kill();
  } catch {
    /* ignore */
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(serverProc.pid), "/T", "/F"], { windowsHide: true });
    } catch {
      /* ignore */
    }
  }
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require("electron").shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadURL(url);
}

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [{ label: "退出", accelerator: "Alt+F4", click: () => app.quit() }],
    },
    {
      label: "视图",
      submenu: [
        {
          label: "刷新",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow?.webContents.reload(),
        },
        {
          label: "开发者工具",
          accelerator: "F12",
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
        { label: "全屏", role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
  });

  app.whenReady().then(async () => {
    buildMenu();
    serverProc = startServer();
    if (!serverProc) return;

    try {
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
