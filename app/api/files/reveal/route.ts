import { NextRequest, NextResponse } from "next/server";
import { existsSync, realpathSync } from "fs";
import { execFile, spawn } from "child_process";
import path from "path";
import { promisify } from "util";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";
import { resolveExternalFileTarget } from "@/lib/univer-paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

const MAX_PATH_LENGTH = 2048;

// explorer.exe exits ~immediately after forwarding the request to the running
// shell; any async spawn error (e.g. ENOENT) surfaces within this window.
// explorer.exe 直接 spawn：窗口会被 Windows 前台锁压住（后台进程激活的窗
// 口不置前——落在应用后面，用户以为「点了没反应」，见 electron/main.cjs
// pi-open-uploads-dir 同款结论）。改用 shell32 COM API 精确选中并尝试置前。
const REVEAL_PS_TIMEOUT_MS = 12_000;
const SHELL32_SELECT_MEMBERS =
  '[System.Runtime.InteropServices.DllImport("shell32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]'
  + "public static extern System.IntPtr ILCreateFromPathW(string pszPath);"
  + '[System.Runtime.InteropServices.DllImport("shell32.dll")]'
  + "public static extern int SHOpenFolderAndSelectItems(System.IntPtr pidl, uint cidl, System.IntPtr apidl, uint dwFlags);"
  + '[System.Runtime.InteropServices.DllImport("shell32.dll")]'
  + "public static extern void ILFree(System.IntPtr pidl);";

/** PowerShell 单引号字面量：内部单引号翻倍转义。 */
function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface RevealPsResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runPowerShellWithTimeout(args: string[], timeoutMs: number): Promise<RevealPsResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn> | null = null;
    let settled = false;
    const timer = setTimeout(() => finish({ code: -1, stdout: "", stderr: "PowerShell timed out" }), timeoutMs);
    const finish = (r: RevealPsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* 已退出 */ }
      resolve(r);
    };
    try {
      child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      finish({ code: -1, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (err) => {
      finish({ code: -1, stdout, stderr: `${stderr}\n${err.message}`.trim() });
    });
    child.on("exit", (code) => {
      finish({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 在资源管理器中打开文件夹并选中文件；随后尽力把窗口调到前台。抛错表示彻底失败。 */
async function revealInWindowsExplorer(realPath: string): Promise<void> {
  const winPath = realPath.replace(/\//g, "\\");
  const folderName = path.win32.basename(path.win32.dirname(winPath));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -Namespace PiReveal -Name ShellApi -MemberDefinition ${psSingleQuoted(SHELL32_SELECT_MEMBERS)} | Out-Null`,
    `$pidl = [PiReveal.ShellApi]::ILCreateFromPathW(${psSingleQuoted(winPath)})`,
    "$hr = [PiReveal.ShellApi]::SHOpenFolderAndSelectItems($pidl, 0, [System.IntPtr]::Zero, 0)",
    "[PiReveal.ShellApi]::ILFree($pidl)",
    "Write-Output ('HR={0:X8}' -f $hr)",
    `if ($hr -eq 0) { $ws = New-Object -ComObject WScript.Shell; for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Milliseconds 400; if ($ws.AppActivate(${psSingleQuoted(folderName)})) { break } } }`,
  ].join("; ");
  const result = await runPowerShellWithTimeout(
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    REVEAL_PS_TIMEOUT_MS,
  );
  const match = /HR=([0-9A-Fa-f]+)/.exec(result.stdout);
  const hr = match ? Number.parseInt(match[1], 16) : null;
  if (hr !== 0) {
    const detail = hr !== null && !Number.isNaN(hr)
      ? `SHOpenFolderAndSelectItems failed (HR=0x${hr.toString(16)})`
      : (result.stderr.trim().split(/\r?\n/)[0] || `exit code ${result.code}`);
    throw new Error(detail);
  }
}

/**
 * Open the containing folder of a file in the OS file manager, with the file
 * selected (Explorer `/select,`). Used by the generated-files card.
 *
 * For a .univer file whose original .xlsx exists next to it, the .xlsx is the
 * reveal target (the user works with the real spreadsheet in Explorer);
 * otherwise the .univer itself is used.
 *
 * POST /api/files/reveal  { filePath } → { ok: true } | 403/404
 *
 * Only paths inside the allowed file roots (same allow-list as /api/files)
 * are accepted — the server never reveals arbitrary locations.
 */
export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { filePath?: unknown } | null;
  const filePath = typeof body?.filePath === "string" ? body.filePath.trim() : "";
  if (!filePath || filePath.length > MAX_PATH_LENGTH) {
    return NextResponse.json({ error: "filePath is required" }, { status: 400 });
  }

  const externalTarget = resolveExternalFileTarget(filePath);
  const existsTarget = existsSync(externalTarget);
  const target = existsTarget ? externalTarget : (externalTarget !== filePath && existsSync(filePath) ? filePath : null);
  if (!target) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(target, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  // Resolve symlinks before revealing so a link inside an allowed root
  // cannot redirect Explorer to an arbitrary location.
  let realPath: string;
  try {
    realPath = realpathSync(target);
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    if (process.platform === "win32") {
      // shell32 COM：打开文件夹并选中，且尝试把窗口调到前台（后台进程直接
      // spawn explorer 的窗口会被前台锁压在应用后面）。失败会抛错→统一 500。
      await revealInWindowsExplorer(realPath);
    } else if (process.platform === "darwin") {
      await execFileAsync("open", ["-R", realPath], { windowsHide: true });
    } else {
      await execFileAsync("xdg-open", [realPath.split("/").slice(0, -1).join("/") || "/"], { windowsHide: true });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  return NextResponse.json({ ok: true, filePath: realPath });
}
