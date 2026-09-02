import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const electronBin = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");

// electron 42+ 不再通过 npm postinstall 下载二进制，改为首次 require('electron') 时懒下载；
// 本脚本直接 spawn electron.exe，触发不了懒下载，所以缺二进制时在这里主动补装一次。
function ensureElectronBinary() {
  if (existsSync(electronBin)) return true;

  const env = { ...process.env };
  if (!env.npm_config_electron_mirror && !env.ELECTRON_MIRROR) {
    // 经 `npm run dev:electron` 启动时 npm 已把项目 .npmrc 的 electron_mirror 注入 env；
    // 直接 `node scripts/dev-electron.mjs` 启动时回退读 .npmrc（GitHub 直连在部分网络下会永久挂起）。
    try {
      const m = readFileSync(path.join(root, ".npmrc"), "utf8")
        .match(/^\s*electron_mirror\s*=\s*(\S+)\s*$/m);
      if (m) env.npm_config_electron_mirror = m[1];
    } catch {
      // 没有 .npmrc 就走 @electron/get 默认源
    }
  }
  const mirror = env.npm_config_electron_mirror || env.ELECTRON_MIRROR;
  console.error(`Electron binary not found — downloading${mirror ? ` (mirror: ${mirror})` : ""}…`);

  const res = spawnSync(process.execPath, [path.join(root, "node_modules", "electron", "install.js")], {
    stdio: "inherit",
    cwd: root,
    env,
    // 无镜像直连 GitHub 可能永久挂起，超时后给出可操作的提示
    timeout: 10 * 60 * 1000,
  });
  return res.status === 0 && existsSync(electronBin);
}

if (!ensureElectronBinary()) {
  console.error(
    "Electron binary download failed (network timeout or mirror unreachable).\n" +
      "Set electron_mirror in .npmrc (e.g. https://npmmirror.com/mirrors/electron/) and retry, " +
      "or run manually: node node_modules/electron/install.js",
  );
  process.exit(1);
}

const childEnv = { ...process.env };
// 从 pi-studio 内置终端等 Electron 环境启动时会带上 ELECTRON_RUN_AS_NODE=1，
// 不清掉的话 electron.exe 会以纯 node 模式运行，main.cjs 里 require('electron') 直接 MODULE_NOT_FOUND
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, ["."], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...childEnv,
    PI_WEB_SERVER_MODE: "dev",
    PI_WEB_PORT: process.env.PI_WEB_PORT || "10141",
    // 开发版与已安装的桌面版 Pi Studio（默认占 9222）区分开，避免 CDP 端口冲突
    PI_WEB_CDP_PORT: process.env.PI_WEB_CDP_PORT || "9223",
    PI_WEB_DIST_DIR: process.env.PI_WEB_DIST_DIR || ".next",
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
