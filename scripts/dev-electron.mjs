import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const electronBin = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");

if (!existsSync(electronBin)) {
  console.error("Electron is not installed. Run npm install first.");
  process.exit(1);
}

const child = spawn(electronBin, ["."], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PI_WEB_SERVER_MODE: "dev",
    PI_WEB_PORT: process.env.PI_WEB_PORT || "10141",
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
