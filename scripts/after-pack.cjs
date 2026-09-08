"use strict";

/**
 * electron-builder afterPack 钩子：把被收集器压平丢弃的嵌套 node_modules 补回打包产物。
 *
 * 背景（2026-09-08 修复「打包 exe 大批 API 返回裸 500」）：
 * electron-builder 的 node_modules 收集器假定「每个包名全局只有一个版本」，会把
 * 依赖树里同名不同版本的嵌套副本（node_modules/<pkg>/node_modules/<dep>）压平到
 * 顶层。本项目 @earendil-works/pi-* 配置为 serverExternalPackages（运行时从
 * node_modules 加载、不进 chunk），而 pi-coding-agent 内部用 ESM 具名导入
 * `import { minimatch } from "minimatch"`，其嵌套依赖是 minimatch@10（有具名导出）；
 * 顶层 minimatch 被 glob@7 等老依赖占成 3.1.5（纯 CJS，无具名导出）→ 收集器把嵌套
 * 的 10.x 丢弃后，打包 exe 运行时解析到 3.1.5，模块加载即抛
 * "The requested module 'minimatch' does not provide an export named 'minimatch'"，
 * /api/sessions、/api/cwd/validate 等所有 import 链上碰到 pi 包的路由全部裸 500。
 * 实测被丢弃的还有 pi-coding-agent 的 chalk/glob/semver 与 pi-tui 的 marked。
 *
 * 本钩子遍历项目 node_modules 里所有「包内嵌套 node_modules」，按「缺失即补、
 * 版本不同即覆盖」同步进打包产物。afterPack 在 nsis/portable 组装安装镜像之前
 * 执行，补进 win-unpacked 的文件会进入最终安装产物。
 */

const fs = require("fs");
const path = require("path");

// 顶层 node_modules 里不需要同步的目录（.pnpm 是 pnpm 虚拟仓库、.bin 是链接）
const SKIP = new Set([".bin", ".pnpm", ".cache"]);

function readVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 缺失或版本不同才复制；版本一致说明产物里的副本与源相同，跳过 */
function copyIfNeeded(src, dst, log, label) {
  const srcVersion = readVersion(src);
  const dstVersion = readVersion(dst);
  if (srcVersion !== null && srcVersion === dstVersion) return;
  fs.cpSync(src, dst, { recursive: true, force: true });
  log.push(`${label}${srcVersion ? `@${srcVersion}` : ""}${dstVersion ? `（覆盖 ${dstVersion}）` : "（新增）"}`);
}

/** 同步一个嵌套 node_modules 目录（srcNm 的各条目 → dstNm） */
function syncNested(srcNm, dstNm, log) {
  for (const entry of fs.readdirSync(srcNm)) {
    if (SKIP.has(entry)) continue;
    const src = path.join(srcNm, entry);
    if (!isDirectory(src)) continue;
    if (entry.startsWith("@")) {
      // scope 目录（如 @smithy）：逐个子包做版本比较
      for (const sub of fs.readdirSync(src)) {
        if (sub === "node_modules") continue;
        const subSrc = path.join(src, sub);
        if (!isDirectory(subSrc)) continue;
        copyIfNeeded(subSrc, path.join(dstNm, entry, sub), log, `${entry}/${sub}`);
      }
    } else {
      copyIfNeeded(src, path.join(dstNm, entry), log, entry);
    }
  }
}

exports.default = async function afterPack(context) {
  const projectRoot = path.resolve(__dirname, "..");
  const srcRoot = path.join(projectRoot, "node_modules");
  // electron-builder 把应用本体放在 <appOutDir>/resources/app/（非 asar 根目录）
  const dstRoot = path.join(context.appOutDir, "resources", "app", "node_modules");
  if (!fs.existsSync(srcRoot) || !fs.existsSync(dstRoot)) return;

  const log = [];
  const packages = []; // [pkgDir, 相对路径]
  for (const entry of fs.readdirSync(srcRoot)) {
    if (entry.startsWith(".")) continue;
    const pkgDir = path.join(srcRoot, entry);
    if (!isDirectory(pkgDir)) continue;
    if (entry.startsWith("@")) {
      for (const sub of fs.readdirSync(pkgDir)) {
        const subDir = path.join(pkgDir, sub);
        if (!isDirectory(subDir)) continue;
        packages.push([subDir, path.join(entry, sub)]);
      }
    } else {
      packages.push([pkgDir, entry]);
    }
  }

  for (const [pkgDir, rel] of packages) {
    const srcNm = path.join(pkgDir, "node_modules");
    if (!fs.existsSync(srcNm)) continue;
    syncNested(srcNm, path.join(dstRoot, rel, "node_modules"), log);
  }

  if (log.length > 0) {
    console.log(`[after-pack] 已补回 ${log.length} 个被压平丢弃的嵌套 node_modules 依赖:`);
    for (const line of log) console.log(`[after-pack]   - ${line}`);
  } else {
    console.log("[after-pack] 嵌套 node_modules 无缺失");
  }
};
