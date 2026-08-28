import { existsSync, mkdirSync, readdirSync, statSync, cpSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * 随应用分发的内置技能同步（打包分发关键路径，2026-08-28）：
 *
 * 打包版的 .agents/skills 随 electron-builder 进入 resources/app，但 skill 的
 * 加载依据是「会话 cwd 的 .agents/skills」+「用户全局 ~/.agents/skills」——
 * 终端用户的会话 cwd 是他们自己的目录，永远看不到 app 内的项目级技能。
 * 因此启动时把 app 内置技能同步到 ~/.agents/skills（SDK 全局信任目录），
 * 任何 cwd 的会话都能加载 office-edit 等内置技能。
 *
 * 管理策略（保护用户自己的技能）：
 * - 只同步 <appRoot>/.agents/skills 下存在 SKILL.md 的目录；
 * - 目标已存在但没有 .pi-studio-bundled 标记 → 视为用户自己的技能，永不覆盖；
 * - 有标记 → 源 SKILL.md 更新时刷新（cpSync 覆盖 + 更新标记时间戳）。
 */

const MARKER = ".pi-studio-bundled";

export function ensureBuiltinSkillsSynced(): void {
  try {
    const srcRoot = join(process.cwd(), ".agents", "skills");
    if (!existsSync(srcRoot)) return;
    const dstRoot = join(homedir(), ".agents", "skills");
    mkdirSync(dstRoot, { recursive: true });
    for (const name of readdirSync(srcRoot)) {
      const src = join(srcRoot, name);
      let isDir = false;
      try {
        isDir = statSync(src).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const srcSkill = join(src, "SKILL.md");
      if (!existsSync(srcSkill)) continue;
      const dst = join(dstRoot, name);
      const dstSkill = join(dst, "SKILL.md");
      if (existsSync(dst) && !existsSync(join(dst, MARKER))) continue; // 用户自己的同名技能，不动
      if (existsSync(dstSkill) && existsSync(join(dst, MARKER))) {
        if (statSync(srcSkill).mtimeMs <= statSync(dstSkill).mtimeMs) continue; // 已是最新
      }
      cpSync(src, dst, { recursive: true, force: true });
      writeFileSync(join(dst, MARKER), new Date().toISOString(), "utf8");
      console.log(`[pi-studio] synced bundled skill: ${name} -> ${dst}`);
    }
  } catch (error) {
    console.error("[pi-studio] failed to sync bundled skills:", error instanceof Error ? error.message : String(error));
  }
}

/**
 * 向本进程（agent 会话的 bash 是它的子进程，继承环境变量）暴露两个
 * 打包版/开发版都稳定可用的路径：
 * - UNIVER_CLI：univer-cli 的绝对入口（打包版在 resources/app/node_modules，
 *   开发版在项目 node_modules）；skill 里用 `node "$UNIVER_CLI" ...` 调用。
 * - PI_WEB_PORT：Web API 端口（electron main 用 PI_WEB_PORT 传给 next，随机
 *   端口场景下子进程只能拿到 "0"，此时 skill 应改走 marker 文件直写，不依赖端口）。
 */
export function ensureAgentEnvExposed(): void {
  try {
    const entry = join(process.cwd(), "node_modules", "univer-cli", "bin", "univer.js");
    if (existsSync(entry)) {
      process.env.UNIVER_CLI = entry.replace(/\\/g, "/");
    }
  } catch {
    /* best-effort */
  }
  try {
    const port = process.env.PI_WEB_PORT;
    if (!port || port === "0") process.env.PI_WEB_PORT = "10141";
  } catch {
    /* best-effort */
  }
}
