import { existsSync } from "fs";
import path from "path";

/**
 * Resolve the git executable to a path that `execFile` can actually run.
 *
 * On Windows, spawning git via `execFile("git", ...)` (or via a backslash
 * path like `D:\Program Files\Git\cmd\git.exe`) can return **empty stdout with
 * exit code 0** — observed with Git for Windows' `cmd` wrapper — while the
 * same binary invoked with a forward-slash path works. Bare `git` resolves
 * through `PATH` to a backslash path, so it hits the same problem.
 *
 * We therefore find the real `git.exe` (searching PATH, then common install
 * roots) and normalize it to forward slashes before executing. Resolved once
 * and memoized on `globalThis` so it survives Next.js hot-reload.
 */
declare global {
  var __piGitExecutable: string | undefined;
}

const WINDOWS_INSTALL_ROOTS = [
  "C:/Program Files/Git",
  "D:/Program Files/Git",
  "C:/Program Files (x86)/Git",
];

const WINDOWS_GIT_SUBPATHS = ["cmd/git.exe", "bin/git.exe", "mingw64/bin/git.exe"];

export function getGitExecutable(): string {
  if (process.platform !== "win32") return "git";
  if (globalThis.__piGitExecutable) return globalThis.__piGitExecutable;

  const candidates: string[] = [];

  // 1) PATH entries (prefer .exe over .cmd/.bat so no shell is needed).
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const ext of [".exe", ".cmd", ".bat"]) {
    for (const dir of pathDirs) {
      candidates.push(path.join(dir, `git${ext}`));
    }
  }

  // 2) Common Git for Windows install roots (PATH may omit them).
  for (const root of WINDOWS_INSTALL_ROOTS) {
    for (const sub of WINDOWS_GIT_SUBPATHS) {
      candidates.push(`${root}/${sub}`);
    }
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const executable = candidate.split(path.sep).join("/");
        globalThis.__piGitExecutable = executable;
        return executable;
      }
    } catch {
      // Ignore unreadable PATH entries.
    }
  }

  // Last resort: let execFile resolve `git` from PATH (may misbehave on
  // Windows, but only reached when no git.exe was found above).
  globalThis.__piGitExecutable = "git";
  return "git";
}
