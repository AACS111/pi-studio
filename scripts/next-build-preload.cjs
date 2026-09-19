/**
 * next build 专用 preload（由 scripts/package.mjs 通过 NODE_OPTIONS --require 注入
 * next build 及其 worker；不进应用运行时，也不进 electron-builder 阶段）。
 *
 * 背景：项目从 C:\Users\zheng\Desktop（用户主目录子树内）搬到 D 盘后，next build
 * 的 nft 文件追踪（TraceEntryPointsPlugin 走查 + collect-build-traces 收尾）会沿
 * 回溯链展开服务端代码里的用户级动态路径（~/.pi 会话、~/.agents、os.tmpdir() 等
 * join() 的结果）：
 *   - glob 以 HOME 为基点，撞上 Windows 系统兼容 junction（My Documents /
 *     Application Data / Local Settings / "Start Menu\程序"，ACL 对任何进程
 *     永久拒绝 scandir）→ EPERM → webpack 判编译失败；
 *   - 若把 EPERM 静默，readdir(主目录) 仍成功返回真实子列表，遍历全量走进
 *     用户主目录，构建 worker 约 17 分钟后 4GB 堆 OOM（exit 134）。
 *
 * 修复（三件套，同一模块缓存内生效）：
 * 1) TraceEntryPointsPlugin.apply 置空 —— webpack 侧追踪走查整体不发生
 *    （EPERM/OOM 的源头，插件会枚举包含 HOME 的 glob）；
 * 2) compiled @vercel/nft 的 nodeFileTrace 替换为空结果桩 —— 补上各消费点
 *    （collect-build-traces 等）可能的重用，返回 {files:[]} 形状的结果；
 * 3) fs.promises.rename 治愈垫片 —— 收尾阶段（build/index.js:2519-2536）把
 *    server/proxy.js.nft.json rename 成 middleware.js.nft.json，这些产物平时
 *    由 trace 插件生成；被禁用后由本垫片兜底：rename 的源是 .nft.json 且
 *    不存在时，先写 {files:[]} 再放行（读回和 .files.map 均兼容）。
 * 应用本身不消费 .nft.json：electron-builder 按 files 清单全量复制 node_modules，
 * 运行时按绝对路径直连用户文件，trace 产物仅有形状意义。
 */
"use strict";
const fs = require("fs");
const path = require("path");

// ---- 简单日志（写 D:\zheng\pi-web\pi-web-main\tmp-preload.log，验证后随文案精简）----
const LOG_PATH = path.join(__dirname, "..", "tmp-preload.log");
function log(line) {
  try {
    fs.appendFileSync(LOG_PATH, `[pid=${process.pid}] ${line}\n`);
  } catch {}
}

// 1) TraceEntryPointsPlugin → noop
try {
  const pluginMod = require("next/dist/build/webpack/plugins/next-trace-entrypoints-plugin");
  const Ctor = pluginMod.TraceEntryPointsPlugin || pluginMod.default;
  if (Ctor && Ctor.prototype) {
    Ctor.prototype.apply = function noopApply() {};
    log("trace entrypoints plugin disabled");
  }
} catch (e) {
  log("plugin patch failed: " + (e && e.message));
}

// 2) nodeFileTrace → 空结果桩
try {
  const nftModule = require("next/dist/compiled/@vercel/nft");
  nftModule.nodeFileTrace = async function stubbedNodeFileTrace() {
    log("nft stub called");
    return {
      fileList: new Set(),
      esmFileList: new Set(),
      reasons: { __stubbed: "next-build-preload" },
      warnings: [],
    };
  };
  log("nft stub installed");
} catch (e) {
  log("nft patch failed: " + (e && e.message));
}

// 3) rename 治愈垫片：缺 .nft.json 源 → 先写 {files:[]} 再放行
try {
  const origRename = fs.promises.rename;
  fs.promises.rename = async function renameHeal(src, dest) {
    try {
      if (
        typeof src === "string" &&
        src.endsWith(".nft.json") &&
        !fs.existsSync(src)
      ) {
        log("rename-heal: creating missing " + src);
        await fs.promises.writeFile(src, JSON.stringify({ files: [] }));
      }
    } catch (e) {
      log("rename-heal write failed: " + (e && e.message));
    }
    return origRename.call(fs.promises, src, dest);
  };
  log("rename-heal installed");
} catch (e) {
  log("rename patch failed: " + (e && e.message));
}
