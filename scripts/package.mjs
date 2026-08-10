#!/usr/bin/env node
// 桌面版构建 + 打包：
//   node scripts/package.mjs          → next build(.next-pkg) + electron-builder --win
//   node scripts/package.mjs --dir    → 只生成 release/win-unpacked（快速验证）
//   node scripts/package.mjs --portable / --nsis → 只生成对应 .exe

import { spawnSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { resolve } from "path";

const root = process.cwd();
const nextBin = resolve(root, "node_modules", "next", "dist", "bin", "next");
const electronBuilderBin = resolve(root, "node_modules", "electron-builder", "cli.js");
const env = {
  ...process.env,
  PI_WEB_DIST_DIR: ".next-pkg",
  // GitHub 在你的网络环境不可达时，打包工具默认会卡在下载上；这里默认走国内镜像。
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR
    || "https://npmmirror.com/mirrors/electron-builder-binaries/",
  ELECTRON_MIRROR:
    process.env.ELECTRON_MIRROR
    || "https://npmmirror.com/mirrors/electron/",
};

if (!existsSync(nextBin)) {
  console.error("[pack] next bin not found:", nextBin);
  process.exit(1);
}

// 桌面版使用独立构建目录，避免污染 npm run dev 的 .next。
rmSync(resolve(root, ".next-pkg"), { recursive: true, force: true });
const build = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
  cwd: root,
  env,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

if (!existsSync(electronBuilderBin)) {
  console.error("[pack] electron-builder not found:", electronBuilderBin);
  process.exit(1);
}

const mode = (process.argv[2] || "").replace(/^--/, "");
const builderArgs = ["--win"];
if (mode === "dir") builderArgs.push("--dir");
else if (["portable", "nsis", "msi"].includes(mode)) builderArgs.push(mode);
else if (mode) builderArgs.push(mode);
builderArgs.push("--publish", "never");
const builder = spawnSync(process.execPath, [electronBuilderBin, ...builderArgs], {
  cwd: root,
  env,
  stdio: "inherit",
});
process.exit(builder.status ?? 1);
