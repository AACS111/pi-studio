// 跨平台标准化 dev 启动器：
// 原因：用户系统里残留了打包环境变量（PI_WEB_DIST_DIR=.next-pkg、NODE_ENV=production），
//      导致 `npm run dev` 被污染、把 dev 产物写进打包目录 .next-pkg 而崩溃（应用打不开）。
// 这里显式覆盖为干净的标准 dev 环境，无论从 cmd / bash / PowerShell 启动都一致。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here); // 项目根（scripts/ 的上一级）
// 参数：node scripts/run-dev.mjs <host> <port>（argv[2]/argv[3]）
const host = process.argv[2] || "127.0.0.1";
const port = process.argv[3] || "10141";

const cleanEnv = {
  ...process.env,
  NODE_ENV: "development",
  PI_WEB_DIST_DIR: ".next", // 强制 dev 产物写到 .next，不受打包残留污染
};

console.log(`[dev-launcher] NODE_ENV=development PI_WEB_DIST_DIR=.next  host=${host} port=${port}`);
const child = spawn(
  process.execPath,
  [join(root, "node_modules/next/dist/bin/next"), "dev", "-H", host, "-p", port],
  { env: cleanEnv, stdio: "inherit", cwd: root }
);
child.on("exit", (code) => process.exit(code ?? 0));