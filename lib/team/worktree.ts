/**
 * P2-1 worktree 隔离（AgentDef.workspace.mode="isolated"）：每个角色执行在独立 git worktree 进行，
 * 成功后合并回主干、失败丢弃、冲突保留现场——多角色并行写同一仓库不再互相覆盖。
 *
 * 复用 lib/worktree.ts 的基础设施（addWorktree/removeWorktree/git-exec 解析、allowed-roots 写路径放行），
 * 本模块补齐团队场景语义：
 *  - 分支命名 team/<agentId>-<seq>-<runId短>（同 run 可重入不冲突）
 *  - 合并前先在 worktree 内 add+commit（执行产物常是未提交状态）
 *  - 冲突：git merge --abort 后保留 worktree+分支供人工检查（不静默丢弃成果）
 *  - 任何失败都不抛出到编排层：create 返回 null（回退共享 cwd），merge/discard 返回结果对象
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { addWorktree, removeWorktree, invalidateProjectCache } from "../worktree.ts";
import { getGitExecutable } from "../git-exec.ts";

const execFileAsync = promisify(execFile);

export interface AgentWorktreeHandle {
  path: string;
  branch: string;
}

export type WorktreeMergeOutcome =
  | { outcome: "merged"; changedFiles?: number }
  | { outcome: "clean" }
  | { outcome: "conflict"; error: string }
  | { outcome: "failed"; error: string };

/** 执行 git（错误文本含 stderr，便于投影消息可读）。LC_ALL=C 固定消息语言。 */
async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync(getGitExecutable(), ["-C", cwd, ...args], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

function gitErr(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim().split("\n").slice(-3).join("; ").slice(0, 300);
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

/** 主仓库根（共享 .git 目录的父目录）；非 git 仓库返回 null。 */
async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const root = commonDir.replace(/[\/]+\.git[\/]?\s*$/, "").trim();
    return root || null;
  } catch {
    return null;
  }
}

/** cwd 是否 git 仓库且当前在分支上（detached HEAD 不能作为合并目标）。 */
async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const ref = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return ref && ref !== "HEAD" ? ref : null;
  } catch {
    return null;
  }
}

/** 创建角色隔离 worktree。
 *  条件不满足（非 git 仓库/detached HEAD/cwd 缺失）或创建失败 → null（调用方回退共享 cwd，
 *  发一条可见提示，绝不阻断执行）。 */
export async function createAgentWorktree(o: {
  cwd?: string;
  runId: string;
  agentId: string;
  sequence: number;
}): Promise<AgentWorktreeHandle | null> {
  if (!o.cwd) return null;
  try {
    const root = await repoRoot(o.cwd);
    if (!root) return null;
    const trunk = await currentBranch(o.cwd);
    if (!trunk) return null; // detached HEAD：无合并目标，不做隔离
    // 分支名：全部小写安全字符；同一角色同一轮重跑会因 seq 不同而不同；已存在则加时间戳后缀
    const safeRun = o.runId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-8) || "run";
    const safeAgent = o.agentId.replace(/[^a-zA-Z0-9_-]/g, "") || "agent";
    const base = `team/${safeAgent}-${o.sequence}-${safeRun}`;
    let branch = base;
    for (let i = 2; i <= 5; i++) {
      try {
        await git(o.cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        branch = `${base}-x${i}`; // 分支已存在（罕见：上一轮保留未清理）→ 换名
      } catch {
        break;
      }
    }
    const wt = await addWorktree(o.cwd, branch);
    return { path: wt.path, branch: wt.branch };
  } catch {
    return null;
  }
}

/** 合并角色 worktree 回主干（执行成功路径调用）。
 *  流程：worktree 内 commit 全部变更 → 主干 merge --no-edit → 清理 worktree+分支。
 *  无变更 → clean；冲突 → abort 主干合并并保留现场（conflict）；其它失败 → failed（保留现场）。 */
export async function mergeAgentWorktree(o: {
  cwd: string;
  handle: AgentWorktreeHandle;
  agentId: string;
  label: string;
}): Promise<WorktreeMergeOutcome> {
  const { handle } = o;
  try {
    // 1) worktree 内提交全部变更（含未跟踪文件；repo 无 user.name/email 时用 -c 兜底）
    await git(handle.path, ["add", "-A"]);
    const status = await git(handle.path, ["status", "--porcelain"]);
    if (!status) {
      await cleanupWorktree(o.cwd, handle, false);
      return { outcome: "clean" };
    }
    const changedFiles = status.split("\n").filter(Boolean).length;
    const commitMsg = `team(${o.agentId}): ${o.label.replace(/\s+/g, " ").slice(0, 120) || "isolated execution"}`;
    await git(handle.path, [
      "-c", "user.name=pi-team", "-c", "user.email=team@pi-studio.local",
      "commit", "-m", commitMsg,
    ]);

    // 2) 主干合并（主干当前分支为合并目标；--no-ff 保留分支边界便于回溯）
    const trunk = await currentBranch(o.cwd);
    if (!trunk) {
      return { outcome: "failed", error: "主仓库当前不在任何分支上（detached HEAD），无法合并" };
    }
    try {
      await git(o.cwd, ["merge", handle.branch, "--no-ff", "--no-edit", "-m", `Merge ${handle.branch} (${o.agentId})`], 120_000);
    } catch (error) {
      const msg = gitErr(error);
      // 冲突：回滚主干侧合并状态，保留 worktree+分支供人工检查
      const conflicted = /CONFLICT|conflict/i.test(msg) ||
        await (async () => { try { const u = await git(o.cwd, ["diff", "--name-only", "--diff-filter=U"]); return Boolean(u); } catch { return false; } })();
      if (conflicted) {
        try { await git(o.cwd, ["merge", "--abort"]); } catch { /* 尽力回滚 */ }
        return { outcome: "conflict", error: msg };
      }
      return { outcome: "failed", error: msg };
    }

    // 3) 清理 worktree（force：worktree 内常有 node_modules 等未跟踪产物）与已合并分支
    await cleanupWorktree(o.cwd, handle, true);
    return { outcome: "merged", changedFiles };
  } catch (error) {
    return { outcome: "failed", error: gitErr(error) };
  }
}

/** 丢弃角色 worktree（执行失败/取消路径调用）。尽力清理，返回是否清理干净。 */
export async function discardAgentWorktree(o: { cwd: string; handle: AgentWorktreeHandle }): Promise<boolean> {
  try {
    await cleanupWorktree(o.cwd, o.handle, true);
    return true;
  } catch {
    return false;
  }
}

async function cleanupWorktree(cwd: string, handle: AgentWorktreeHandle, deleteBranch: boolean): Promise<void> {
  try {
    await removeWorktree(cwd, handle.path, true);
  } catch {
    // removeWorktree 要求 path 是本仓库的 worktree；失败再直接用 git 兜底
    try { await git(cwd, ["worktree", "remove", "--force", handle.path]); } catch { /* 尽力 */ }
  }
  if (deleteBranch) {
    try { await git(cwd, ["branch", "-D", handle.branch]); } catch { /* 尽力 */ }
  }
  invalidateProjectCache();
}
