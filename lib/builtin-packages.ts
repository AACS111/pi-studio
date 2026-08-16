/**
 * 内置 pi 包注册（builtin packages）
 *
 * 随应用分发的 pi 包（如 packages/pi-memory-zh）需要在首次启动时注册进
 * `~/.pi/agent/settings.json` 的 `packages` 数组，pi 引擎（SettingsManager）才会
 * 加载它们的扩展。开发模式已手动配置的包（指向 ~/pi-packages 的相对路径）不会被重复注册。
 *
 * 幂等规则：
 *  - packages 里已存在任何包含 "pi-memory-zh" 的条目（绝对或相对路径）→ 跳过，不重复；
 *  - 不存在 → 追加绝对路径（打包后应用目录 <app>/packages/pi-memory-zh，dev 为项目目录）。
 *
 * 原子写：与 lib/atomic-file.ts 相同的 tmp+rename 策略，避免并发启动竞态。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const BUILTIN_PACKAGES = ["pi-memory-zh"] as const;

export type BuiltinPackageName = (typeof BUILTIN_PACKAGES)[number];

/** 计算内置包在应用内的绝对路径（dev：项目目录；打包：安装目录），存在才返回 */
export function builtinPackagePath(name: BuiltinPackageName): string | null {
  const p = join(resolve(process.cwd()), "packages", name);
  return existsSync(p) ? p : null;
}

/** 确保 settings.json 的 packages 包含全部内置包（幂等、失败不抛错） */
export function ensureBuiltinPackagesRegistered(): void {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    const settings: { packages?: unknown[] } = existsSync(settingsPath)
      ? JSON.parse(readFileSync(settingsPath, "utf8"))
      : {};

    const packages: string[] = (settings.packages ?? []).filter(
      (p): p is string => typeof p === "string",
    );

    let changed = false;
    for (const name of BUILTIN_PACKAGES) {
      // 已有任何指向该包的条目（相对/绝对/npm/git 均可）则不重复注册
      if (packages.some((p) => p.includes(name))) continue;

      const abs = builtinPackagePath(name);
      if (!abs) continue;
      packages.push(abs);
      changed = true;
    }

    if (!changed) return;

    settings.packages = packages;
    const tmp = join(tmpdir(), `pi-web-settings-${process.pid}-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    renameSync(tmp, settingsPath);
    console.log(`[pi-studio] builtin packages registered: ${BUILTIN_PACKAGES.join(", ")}`);
  } catch (err) {
    console.error(
      "[pi-studio] failed to register builtin packages:",
      err instanceof Error ? err.message : err,
    );
  }
}
