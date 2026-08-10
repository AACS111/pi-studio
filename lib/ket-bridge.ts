import { execFile } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { getInternalDir } from "./storage-config";
import { getFileExt } from "./file-types";

/**
 * 加密 .xlsx 的 KET（WPS 表格）COM 解冻桥。
 *
 * 加密的 .xlsx（含 WPS 的 TSD 加密 / 标准 OOXML 加密）无法被 fflate/SheetJS
 * 直接解析，此时改走 WP5 KET COM 自动化（ProgID "Ket.Application"，即 WPS
 * 表格）：
 *
 *  1) 首选：Workbooks.Open（可带密码）→ SaveAs(FileFormat=51) 另存为普通
 *     .xlsx，校验输出确实是标准 zip（PK 魔数 + [Content_Types].xml）。普通
 *     WPS 安装上能得到完整保真的解密文件。
 *  2) 兜底：部分 WPS 365 企业版强制把 SaveAs 输出包成 TSD 加密容器（对任意
 *     文件都是，含未加密文件），此时改走 COM 数据提取：通过 Application 级
 *     Range 读取活动工作表的值/公式/列宽/行高/合并区域，再用 SheetJS 重建
 *     标准 .xlsx。注意这类受限环境只允许读活动工作表，多工作表文件只能还原
 *     当前活动页。
 *
 * 检测：标准加密 .xlsx = OLE 复合文档（D0CF11E0）；WPS TSD 加密 = 文件头
 * "%TSD-Header-###%"；WPS 结构加密 = zip 但缺标准 xl/ 部件。
 * 解密结果按「源路径|大小|mtime|密码」缓存于 pi-studio 内部目录。
 */

const execFileAsync = promisify(execFile);

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b]);
const TSD_MAGIC = Buffer.from("%TSD-Header-###%", "latin1");

/** 打开/提取超时（WPS 冷启动 + 大表读取可能较慢；也是防弹窗挂死的兜底）。 */
const KET_TIMEOUT_MS = 90_000;
const KET_CACHE_MAX_FILES = 32;
const KET_CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export type SpreadsheetKind = "plain" | "encrypted" | "unknown";

/**
 * 判断一个表格文件是否需要走 KET 解密：
 * - .xlsx + OLE 复合文档魔数 → 标准 OOXML 加密；
 * - .xlsx + WPS TSD 头（"%TSD-Header-###%"）→ WPS/金山 TSD 加密；
 * - .xlsx/.xls + zip 魔数但末尾中央目录里找不到标准条目 → WPS 结构加密；
 * - 其余（普通 xlsx / 旧版 .xls / 非表格）→ plain/unknown，走原解析路径。
 */
export function detectSpreadsheetKind(filePath: string): SpreadsheetKind {
  const ext = getFileExt(filePath);
  if (ext !== "xlsx" && ext !== "xls") return "unknown";

  const head = readHead(filePath, 64);
  if (!head) return "unknown";

  if (head.subarray(0, 8).equals(OLE_MAGIC)) {
    // 旧版 .xls 也是 OLE，但 SheetJS 可直接读；只有 .xlsx 的 OLE 容器才是加密。
    return ext === "xlsx" ? "encrypted" : "plain";
  }
  if (head.subarray(0, TSD_MAGIC.length).equals(TSD_MAGIC)) {
    return "encrypted";
  }
  if (head.subarray(0, 2).equals(ZIP_MAGIC)) {
    return looksLikePlainZip(filePath) ? "plain" : "encrypted";
  }
  return "unknown";
}

function readHead(filePath: string, size: number): Buffer | null {
  try {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(size);
      const n = readSync(fd, buf, 0, size, 0);
      return buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** 检查 zip 末尾的中央目录（entry 名以明文存于其中）是否含标准 OOXML 条目。 */
function looksLikePlainZip(filePath: string): boolean {
  try {
    const st = statSync(filePath);
    const tailSize = Math.min(st.size, 64 * 1024);
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(tailSize);
      const n = readSync(fd, buf, 0, tailSize, st.size - tailSize);
      const tail = buf.subarray(0, n).toString("latin1");
      return tail.includes("xl/workbook.xml") || tail.includes("[Content_Types].xml");
    } finally {
      closeSync(fd);
    }
  } catch {
    return true; // 读尾失败时宽松处理，交给下游解析报错
  }
}

/** 是否标准 zip 格式的 xlsx（KET SaveAs 成功产出可解析文件）。 */
function isPlainXlsx(filePath: string): boolean {
  try {
    const head = readHead(filePath, 8);
    if (!head || !head.subarray(0, 2).equals(ZIP_MAGIC)) return false;
    const st = statSync(filePath);
    const tailSize = Math.min(st.size, 64 * 1024);
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(tailSize);
      const n = readSync(fd, buf, 0, tailSize, st.size - tailSize);
      const tail = buf.subarray(0, n).toString("latin1");
      return tail.includes("[Content_Types].xml") || tail.includes("xl/workbook.xml");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export interface KetDecryptResult {
  ok: boolean;
  /** 解冻后的普通 .xlsx 路径（缓存于 pi-studio 内部目录）。 */
  outPath?: string;
  code?:
    | "KET_PASSWORD_REQUIRED"
    | "KET_PASSWORD_WRONG"
    | "KET_UNAVAILABLE"
    | "KET_TIMEOUT"
    | "KET_FAILED";
  error?: string;
}

function ketCacheDir(): string {
  const dir = join(getInternalDir(), "ket-decrypt");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 后续写入会报错 */
  }
  return dir;
}

/** 同 key 并发请求共享一次 WPS 拉起。 */
const inFlight = new Map<string, Promise<KetDecryptResult>>();

/**
 * 用 WPS KET COM（Ket.Application）打开（可选密码）并得到普通 .xlsx：
 * 优先 SaveAs 另存（完整保真），产出仍为 TSD/加密时退化为 COM 数据提取重建。
 * 结果按文件指纹缓存；密码缺失/错误通过 code 区分。
 */
export function decryptViaKet(sourcePath: string, options?: { password?: string }): Promise<KetDecryptResult> {
  if (process.platform !== "win32") {
    return Promise.resolve({
      ok: false,
      code: "KET_UNAVAILABLE",
      error: "KET COM 解密仅支持 Windows（需安装 WPS 表格）",
    });
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(sourcePath);
  } catch {
    return Promise.resolve({ ok: false, code: "KET_FAILED", error: "源文件不存在" });
  }
  const password = options?.password ?? "";
  const key = createHash("sha1")
    .update(`${sourcePath}|${st.size}|${st.mtimeMs}|${password}`)
    .digest("hex");
  const outPath = join(ketCacheDir(), `decrypted-${key}.xlsx`);

  const cached = inFlight.get(key);
  if (cached) return cached;

  const p = doDecrypt(sourcePath, outPath, password).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

async function doDecrypt(sourcePath: string, outPath: string, password: string): Promise<KetDecryptResult> {
  if (existsSync(outPath) && statSync(outPath).size > 0 && isPlainXlsx(outPath)) {
    return { ok: true, outPath };
  }
  try {
    rmSync(outPath, { force: true });
  } catch {
    /* ignore */
  }

  const scriptPath = join(ketCacheDir(), `ket-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  // PowerShell 5.1 无 BOM 时按 ANSI 解析 .ps1：脚本全 ASCII + 写 BOM 双保险。
  writeFileSync(scriptPath, "\uFEFF" + KET_BRIDGE_SCRIPT, "utf8");
  try {
    const { stdout: stdoutBuf } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-SourcePath", sourcePath,
        "-OutPath", outPath,
        "-Password", password,
      ],
      { windowsHide: true, timeout: KET_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
    );
    // PowerShell 脚本已强制 UTF-8 输出，这里按 UTF-8 解码。
    const stdout = stdoutBuf.toString("utf8");

    if (stdout.includes("KET_FILE_OK") && existsSync(outPath) && isPlainXlsx(outPath)) {
      pruneCache();
      return { ok: true, outPath };
    }

    // COM 提取重建路径
    const jsonMatch = /KET_JSON_START\r?\n([\s\S]*?)\r?\nKET_JSON_END/.exec(stdout);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]) as KetExtraction;
        const rebuilt = await rebuildXlsxFromExtraction(data, outPath);
        if (rebuilt) {
          pruneCache();
          return { ok: true, outPath };
        }
      } catch (error) {
        return {
          ok: false,
          code: "KET_FAILED",
          error: `KET 数据重建失败: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    const errLine = /KET_ERROR:\s*(.*)/.exec(stdout);
    return {
      ok: false,
      code: "KET_FAILED",
      error: errLine?.[1]?.trim() || stdout.trim() || "KET 解密失败",
    };
  } catch (error) {
    const err = error as { code?: string; killed?: boolean; stdout?: Buffer; stderr?: Buffer; message?: string };
    if (err.code === "ETIMEDOUT" || err.killed) {
      return {
        ok: false,
        code: "KET_TIMEOUT",
        error: "KET 打开超时（文件可能正被 WPS 弹窗等待输入，或需要打开密码）",
      };
    }
    const out = `${(err.stdout ?? Buffer.from("")).toString("utf8")}${(err.stderr ?? Buffer.from("")).toString("utf8")}${err.message ?? ""}`;
    const errLine = /KET_ERROR:\s*([^\r\n]*)/.exec(out);
    const rawMsg = errLine?.[1]?.trim() ?? out.trim();
    if (/password|Password|protect|Protect|encrypt|Encrypt|FFF4000|密码|口令|加密/i.test(out)) {
      return {
        ok: false,
        code: password ? "KET_PASSWORD_WRONG" : "KET_PASSWORD_REQUIRED",
        error: password
          ? `密码错误，无法打开加密表格${rawMsg ? `（${rawMsg}）` : ""}`
          : `该表格已加密，需要打开密码${rawMsg ? `（${rawMsg}）` : ""}`,
      };
    }
    return {
      ok: false,
      code: "KET_UNAVAILABLE",
      error: rawMsg || "无法启动 WPS KET COM（Ket.Application），请确认已安装 WPS 表格",
    };
  } finally {
    try {
      rmSync(scriptPath, { force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* COM 提取数据 → SheetJS 重建普通 .xlsx                                */
/* ------------------------------------------------------------------ */

interface KetExtraction {
  rows: number;
  cols: number;
  values: Array<Array<unknown>> | null;
  formulas?: Array<Array<unknown>> | null;
  numfmt?: string | null;
  colWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
  merges?: Array<{ r: number; c: number; rows: number; cols: number }>;
  /** 值为日期（OADate 序列号）的格子坐标集合。 */
  dateCells?: Array<Array<boolean>> | null;
}

async function rebuildXlsxFromExtraction(data: KetExtraction, outPath: string): Promise<boolean> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const ws: Record<string, unknown> = {};
  const rows = Math.max(1, data.rows ?? 0);
  const cols = Math.max(1, data.cols ?? 0);

  const values = data.values ?? [];
  const formulas = data.formulas ?? [];
  const dateCells = data.dateCells ?? [];

  for (let r = 0; r < rows; r++) {
    const row = values[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < cols; c++) {
      const v = row[c];
      if (v === null || v === undefined || v === "") continue;
      const cell: Record<string, unknown> = {};
      const f = formulas[r]?.[c];
      if (typeof f === "string" && f.startsWith("=")) cell.f = f;
      if (typeof v === "number") {
        cell.t = "n";
        cell.v = v;
        // 日期序列号：带上默认日期格式，避免显示成裸数字
        if (dateCells[r]?.[c]) {
          cell.s = { n: { pattern: "yyyy/m/d" } };
        }
      } else if (typeof v === "boolean") {
        cell.t = "b";
        cell.v = v;
      } else {
        cell.t = "s";
        cell.v = String(v);
      }
      ws[XLSX.utils.encode_cell({ r, c })] = cell;
    }
  }

  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows - 1, c: cols - 1 } });
  if (data.colWidths) {
    const colsArr: Array<{ wch?: number }> = [];
    for (const key of Object.keys(data.colWidths)) {
      const idx = Number(key) - 1;
      if (idx >= 0) colsArr[idx] = { wch: data.colWidths[key] };
    }
    ws["!cols"] = colsArr;
  }
  if (data.rowHeights) {
    const rowsArr: Array<{ hpt?: number }> = [];
    for (const key of Object.keys(data.rowHeights)) {
      const idx = Number(key) - 1;
      if (idx >= 0) rowsArr[idx] = { hpt: data.rowHeights[key] };
    }
    ws["!rows"] = rowsArr;
  }
  if (data.merges && data.merges.length > 0) {
    ws["!merges"] = data.merges.map((m) => ({
      s: { r: m.r, c: m.c },
      e: { r: m.r + m.rows - 1, c: m.c + m.cols - 1 },
    }));
  }
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const bin = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
  writeFileSync(outPath, Buffer.from(bin));
  return existsSync(outPath) && statSync(outPath).size > 0 && isPlainXlsx(outPath);
}

function pruneCache(): void {
  try {
    const dir = ketCacheDir();
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("decrypted-") && f.endsWith(".xlsx"))
      .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(KET_CACHE_MAX_FILES)) {
      try { rmSync(join(dir, f.name), { force: true }); } catch { /* ignore */ }
    }
    const cutoff = Date.now() - KET_CACHE_MAX_AGE_MS;
    for (const f of files) {
      if (f.mtime < cutoff) {
        try { rmSync(join(dir, f.name), { force: true }); } catch { /* ignore */ }
      }
    }
  } catch {
    /* 尽力而为 */
  }
}

/**
 * PowerShell：Ket.Application 打开（可选密码）→ SaveAs(51) 尝试完整解密；
 * 输出仍是 TSD/加密时退化为 COM 提取活动表数据（Application 级 Range）。
 * 协议：
 *  - "KET_FILE_OK"            → OutPath 已是普通 xlsx（完整保真）
 *  - "KET_JSON_START..END"    → 提取数据 JSON，Node 端重建
 *  - "KET_ERROR: <msg>" + 退出码 20=密码问题 / 21=其他 COM 错误
 * 退出码 0 表示脚本正常完成（含两种成功路径）。
 */
const KET_BRIDGE_SCRIPT = String.raw`
param(
  [string]$SourcePath,
  [string]$OutPath,
  [string]$Password
)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$ket = $null
$wb = $null
try {
  $ket = New-Object -ComObject Ket.Application
  $ket.Visible = $false
  try { $ket.DisplayAlerts = $false } catch { }

  function OpenWb {
    if ([string]::IsNullOrEmpty($Password)) {
      return $ket.Workbooks.Open($SourcePath, 0, $true)
    }
    return $ket.Workbooks.Open($SourcePath, 0, $true, 5, $Password)
  }

  function ColLetter($n) {
    $s = ''
    while ($n -gt 0) {
      $m = ($n - 1) % 26
      $s = [char](65 + $m) + $s
      $n = [int](($n - 1) / 26)
    }
    return $s
  }

  $wb = OpenWb
  if ($wb -eq $null) { throw "Failed to open workbook" }

  # ---- 1) SaveAs 完整解密（普通 WPS 安装）----
  $plain = $false
  try {
    $wb.SaveAs($OutPath, 51)
    try { $wb.Close($false) } catch { }
    $wb = $null
    if (Test-Path $OutPath) {
      for ($attempt = 0; $attempt -lt 8 -and -not $plain; $attempt++) {
        try {
          $fs = [System.IO.File]::OpenRead($OutPath)
          try {
            $head = New-Object byte[] 8
            $n = $fs.Read($head, 0, 8)
            if ($n -ge 4 -and $head[0] -eq 0x50 -and $head[1] -eq 0x4b) { $plain = $true }
          } finally { $fs.Close() }
        } catch { Start-Sleep -Milliseconds 400 }
      }
    }
  } catch {
    $plain = $false
  }

  if ($plain) {
    Write-Output "KET_FILE_OK"
    exit 0
  }

  # ---- 2) SaveAs 失败或产出 TSD → COM 提取活动表数据 ----
  if ($wb -eq $null) { $wb = OpenWb }
  if ($wb -eq $null) { throw "Failed to reopen workbook" }

  $lc = $ket.Cells.SpecialCells(11)
  $rows = [int]$lc.Row
  $cols = [int]$lc.Column
  if ($rows -lt 1) { $rows = 1 }
  if ($cols -lt 1) { $cols = 1 }
  if ($rows * $cols -gt 2000000) { $rows = [Math]::Floor(2000000 / $cols); if ($rows -lt 1) { $rows = 1 } }
  $addr = "A1:" + (ColLetter $cols) + $rows

  $values = $null
  $formulas = $null
  $numfmt = $null
  try { $values = $ket.Range($addr).Value2 } catch { }
  try { $formulas = $ket.Range($addr).Formula } catch { }
  try { $numfmt = $ket.Range($addr).NumberFormat } catch { }

  $dateCells = @()
  function ToNested($raw) {
    if ($null -eq $raw) { return $null }
    if ($raw -is [Array]) {
      if ($raw.Rank -eq 2) {
        $out = @()
        $r0 = $raw.GetLowerBound(0); $r1 = $raw.GetUpperBound(0)
        $c0 = $raw.GetLowerBound(1); $c1 = $raw.GetUpperBound(1)
        for ($i = $r0; $i -le $r1; $i++) {
          $row = @()
          for ($j = $c0; $j -le $c1; $j++) {
            $v = $raw[$i, $j]
            if ($v -is [datetime]) {
              $row += [double]$v.ToOADate()
              $script:dateCells += ,@($i, $j)
            } else {
              $row += $v
            }
          }
          $out += ,$row
        }
        return ,$out
      }
      return ,@($raw)
    }
    if ($raw -is [datetime]) {
      $script:dateCells += ,@(0, 0)
      return ,@(@([double]$raw.ToOADate()))
    }
    return ,@(@($raw))
  }
  $valuesN = ToNested $values
  $formulasN = ToNested $formulas
  $numfmtN = $null
  if ($null -ne $numfmt -and [string]$numfmt -ne 'General' -and [string]$numfmt -ne '') { $numfmtN = [string]$numfmt }

  $colWidths = @{}
  for ($c = 1; $c -le $cols; $c++) {
    try {
      $w = $ket.Columns.Item($c).ColumnWidth
      if ($null -ne $w -and $w -gt 0 -and [Math]::Abs($w - 8.38) -gt 0.05) { $colWidths[[string]$c] = $w }
    } catch { }
  }
  $rowHeights = @{}
  for ($r = 1; $r -le [Math]::Min($rows, 2000); $r++) {
    try {
      $h = $ket.Rows.Item($r).RowHeight
      if ($null -ne $h -and $h -gt 0 -and [Math]::Abs($h - 15) -gt 0.1) { $rowHeights[[string]$r] = $h }
    } catch { }
  }

  $merges = @()
  try {
    $mergeFlags = $ket.Range($addr).MergeCells
    $isArray = $mergeFlags -is [Array]
    for ($r = 0; $r -lt $rows; $r++) {
      for ($c = 0; $c -lt $cols; $c++) {
        $merged = $false
        if ($isArray) {
          try { $merged = [bool]$mergeFlags[$r, $c] } catch { }
        } else {
          try { $merged = [bool]$mergeFlags } catch { }
        }
        if ($merged) {
          $cellRef = (ColLetter ($c + 1)) + ($r + 1)
          $cell = $ket.Range($cellRef)
          $area = $cell.MergeArea
          $mr = [int]$area.Rows.Count
          $mc = [int]$area.Columns.Count
          $found = $false
          foreach ($m in $merges) {
            if ($m.r -eq $r -and $m.c -eq $c) { $found = $true; break }
          }
          if (-not $found) {
            $merges += @{ r = $r; c = $c; rows = $mr; cols = $mc }
          }
        }
      }
    }
  } catch { }

  $dateGrid = @()
  for ($r = 0; $r -lt $rows; $r++) {
    $dr = @()
    for ($c = 0; $c -lt $cols; $c++) { $dr += $false }
    $dateGrid += ,$dr
  }
  foreach ($dc in $dateCells) {
    $rr = [int]$dc[0]; $cc = [int]$dc[1]
    if ($rr -ge 0 -and $rr -lt $rows -and $cc -ge 0 -and $cc -lt $cols) { $dateGrid[$rr][$cc] = $true }
  }

  $result = [ordered]@{
    rows = $rows
    cols = $cols
    values = $valuesN
    formulas = $formulasN
    numfmt = $numfmtN
    colWidths = $colWidths
    rowHeights = $rowHeights
    merges = $merges
    dateCells = $dateGrid
  }
  $json = $result | ConvertTo-Json -Depth 30 -Compress
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output "KET_JSON_START"
  Write-Output $json
  Write-Output "KET_JSON_END"
  try { $wb.Close($false) } catch { }
  $wb = $null
  exit 0
}
catch {
  $msg = $_.Exception.Message
  Write-Output ("KET_ERROR: " + $msg)
  if ($msg -match 'password|Password|protect|Protect|encrypt|Encrypt|FFF4000') { exit 20 }
  exit 21
}
finally {
  if ($wb -ne $null) { try { $wb.Close($false) } catch { } }
  if ($ket -ne $null) {
    try { $ket.Quit() } catch { }
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ket) | Out-Null } catch { }
  }
}
`;
