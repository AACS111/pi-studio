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
 *     文件都是，含未加密文件；实测 WPS 12.0 即如此——csv/xls/xlsb/xlsx 全部
 *     被包），且工作表级 COM 访问被拒（E_ACCESSDENIED），此时改走 COM 数据
 *     提取：通过 Application 级 Range 读取活动工作表的值/公式/列宽/行高/合并
 *     区域，再用 SheetJS 重建标准 .xlsx。这类受限环境只允许读活动工作表，
 *     多工作表文件只能还原当前活动页（partial=true，sheetsTotal 给出总数）。
 *
 * 检测：标准加密 .xlsx = OLE 复合文档（D0CF11E0）；WPS TSD 加密 = 文件头
 * "%TSD-Header-###%"；WPS 结构加密 = zip 但缺标准 xl/ 部件。
 * 解密结果按「源路径|大小|mtime|密码」缓存于 pi-studio 内部目录。
 *
 * ── 性能坑（2026-08-17 实测修复）──
 * PowerShell 5.1 对二维数组的逐元素索引 `$arr[$r,$c]` 走反射慢路径，24780 格
 * 要几分钟（原实现在合并检测循环上挂死 >150s）；`ConvertTo-Json -Depth 30`
 * 对大嵌套数组同样极慢。修复：所有 COM 返回的 2D 数组一次性 `foreach` 展平为
 * 1D 再索引；序列化改用 StringBuilder 紧凑行协议（非 JSON）。实测 295×84 表
 * 15s 完成（含 WPS 冷启动）。
 * 另：超时被杀会残留 et/wps 进程与模态「文档已加密」弹窗，阻塞后续所有 KET
 * 调用——脚本输出本次新建的 WPS PID，Node 端在 finally 一律清理。
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
  /** true = 仅还原了活动工作表（WPS 365 受限环境 SaveAs 被 TSD 包裹时走提取重建）。 */
  partial?: boolean;
  /** 源工作簿工作表总数（partial 时用于提示丢失的表）。 */
  sheetsTotal?: number;
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
  // 本次调用可能新建的 WPS 进程（超时被杀后残留，会阻塞后续 KET 调用/弹「文档已加密」窗）。
  let spawnedWpsPids: number[] = [];
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
      { windowsHide: true, timeout: KET_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
    );
    // PowerShell 脚本已强制 UTF-8 输出，这里按 UTF-8 解码。
    const stdout = stdoutBuf.toString("utf8");

    // 脚本报告的本次新建 WPS 进程（et/wps），用于 finally 清理残留。
    const pidMatch = /KET_WPS_PIDS:\s*([\d,\s]+)/.exec(stdout);
    if (pidMatch) {
      spawnedWpsPids = pidMatch[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    }

    if (stdout.includes("KET_FILE_OK") && existsSync(outPath) && isPlainXlsx(outPath)) {
      pruneCache();
      return { ok: true, outPath };
    }

    // COM 提取重建路径（紧凑行协议，见 KET_BRIDGE_SCRIPT）
    const jsonMatch = /KET_JSON_START\r?\n([\s\S]*?)\r?\nKET_JSON_END/.exec(stdout);
    if (jsonMatch) {
      try {
        const data = parseExtractionProtocol(jsonMatch[1]);
        const rebuilt = await rebuildXlsxFromExtraction(data, outPath);
        if (rebuilt) {
          pruneCache();
          return {
            ok: true,
            outPath,
            partial: true,
            sheetsTotal: data.sheetsTotal ?? undefined,
          };
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
        error: "KET 打开超时（WPS 冷启动/大表提取较慢，或文件需要打开密码后仍在等待）",
      };
    }
    const out = `${(err.stdout ?? Buffer.from("")).toString("utf8")}${(err.stderr ?? Buffer.from("")).toString("utf8")}${err.message ?? ""}`;
    const pidMatch = /KET_WPS_PIDS:\s*([\d,\s]+)/.exec(out);
    if (pidMatch) {
      spawnedWpsPids = pidMatch[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    }
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
    // 清理本次调用新建的 WPS 进程：正常路径脚本已 Quit（进程已死，kill 静默失败），
    // 超时被杀路径残留的 et/wps 与模态弹窗必须清掉，否则阻塞后续所有 KET 调用。
    for (const pid of spawnedWpsPids) {
      try {
        process.kill(pid, 0); // 存在才 kill
        try {
          // Windows 下 SIGTERM 等效强制终止子进程
          execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        } catch { /* ignore */ }
      } catch {
        /* 进程已退出 */
      }
    }
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
  /** 活动工作表名（WPS 受限环境可能拿不到，空则用 Sheet1）。 */
  sheetName: string;
  /** 源工作簿工作表总数。 */
  sheetsTotal: number;
  /** 行数组（每行是列数组，元素为 string|number|boolean|null）。 */
  values: Array<Array<unknown>>;
  /** 稀疏公式表：key "r,c" → 公式文本（以 = 开头）。 */
  formulas?: Record<string, string>;
  colWidths?: Record<string, number>;
  rowHeights?: Record<string, number>;
  merges?: Array<{ r: number; c: number; rows: number; cols: number }>;
  /** 值为日期（OADate 序列号）的格子坐标集合，key "r,c"。 */
  dateCells: Set<string>;
}

/**
 * 解析 PowerShell 侧输出的紧凑行协议（避免 ConvertTo-Json 在 PS 5.1 上的
 * 灾难性性能）：
 *   SHEETS|<total>
 *   META|<rows>|<cols>|<escaped sheetName>
 *   <rows 行，每行 <cols> 个制表符分隔单元，单元前缀：E/N:/D:/B:/S:>
 *   ENDVALUES
 *   [FORMULAS
 *    <r>,<c>,<escaped formula> ...]
 *   COLW|<c>=<w>,...
 *   ROWH|<r>=<h>,...
 *   MERGES|<r>,<c>,<rows>,<cols>;...
 */
function parseExtractionProtocol(body: string): KetExtraction {
  const lines = body.split(/\r?\n/);
  let sheetsTotal = 1;
  let rows = 0;
  let cols = 0;
  let sheetName = "";
  let inValues = false;
  let inFormulas = false;
  const values: Array<Array<unknown>> = [];
  const formulas: Record<string, string> = {};
  const dateCells = new Set<string>();
  const colWidths: Record<string, number> = {};
  const rowHeights: Record<string, number> = {};
  const merges: Array<{ r: number; c: number; rows: number; cols: number }> = [];

  const unescape = (s: string): string =>
    s.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");

  for (const line of lines) {
    if (line.startsWith("SHEETS|")) {
      sheetsTotal = Number(line.slice(7)) || 1;
    } else if (line.startsWith("META|")) {
      const parts = line.split("|");
      rows = Number(parts[1]) || 0;
      cols = Number(parts[2]) || 0;
      sheetName = parts[3] ? unescape(parts.slice(3).join("|")) : "";
      inValues = true;
      inFormulas = false;
    } else if (line === "ENDVALUES") {
      inValues = false;
    } else if (line === "FORMULAS") {
      inValues = false;
      inFormulas = true;
    } else if (inValues && rows > 0 && cols > 0) {
      const cells = line.split("\t");
      const rowArr: Array<unknown> = [];
      const rIdx = values.length;
      for (let c = 0; c < cols; c++) {
        const raw = cells[c];
        if (raw === undefined || raw === "E" || raw === "") {
          rowArr.push(null);
        } else if (raw.startsWith("N:")) {
          rowArr.push(Number(raw.slice(2)));
        } else if (raw.startsWith("D:")) {
          rowArr.push(Number(raw.slice(2)));
          dateCells.add(`${rIdx},${c}`);
        } else if (raw.startsWith("B:")) {
          rowArr.push(raw.slice(2) === "true");
        } else if (raw.startsWith("S:")) {
          rowArr.push(unescape(raw.slice(2)));
        } else {
          // 未知前缀：按文本处理（旧协议兜底）
          rowArr.push(unescape(raw));
        }
      }
      values.push(rowArr);
    } else if (inFormulas) {
      const comma1 = line.indexOf(",");
      const comma2 = comma1 >= 0 ? line.indexOf(",", comma1 + 1) : -1;
      if (comma1 >= 0 && comma2 >= 0) {
        const r = Number(line.slice(0, comma1));
        const c = Number(line.slice(comma1 + 1, comma2));
        formulas[`${r},${c}`] = unescape(line.slice(comma2 + 1));
      }
    } else if (line.startsWith("COLW|")) {
      for (const pair of line.slice(5).split(",")) {
        const eq = pair.indexOf("=");
        if (eq > 0) colWidths[pair.slice(0, eq)] = Number(pair.slice(eq + 1));
      }
    } else if (line.startsWith("ROWH|")) {
      for (const pair of line.slice(5).split(",")) {
        const eq = pair.indexOf("=");
        if (eq > 0) rowHeights[pair.slice(0, eq)] = Number(pair.slice(eq + 1));
      }
    } else if (line.startsWith("MERGES|")) {
      for (const seg of line.slice(7).split(";")) {
        const parts = seg.split(",");
        if (parts.length === 4) {
          merges.push({ r: Number(parts[0]), c: Number(parts[1]), rows: Number(parts[2]), cols: Number(parts[3]) });
        }
      }
    }
  }

  return { rows, cols, sheetName, sheetsTotal, values, formulas, dateCells, colWidths, rowHeights, merges };
}

async function rebuildXlsxFromExtraction(data: KetExtraction, outPath: string): Promise<boolean> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const ws: Record<string, unknown> = {};
  const rows = Math.max(1, data.rows ?? 0);
  const cols = Math.max(1, data.cols ?? 0);

  const values = data.values ?? [];
  const formulas = data.formulas ?? {};
  const dateCells = data.dateCells ?? new Set<string>();

  for (let r = 0; r < rows; r++) {
    const row = values[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < cols; c++) {
      const v = row[c];
      if (v === null || v === undefined || v === "") continue;
      const cell: Record<string, unknown> = {};
      const f = formulas[`${r},${c}`];
      if (typeof f === "string" && f.startsWith("=")) cell.f = f;
      if (typeof v === "number") {
        cell.t = "n";
        cell.v = v;
        // 日期序列号：带上默认日期格式，避免显示成裸数字
        if (dateCells.has(`${r},${c}`)) {
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
  XLSX.utils.book_append_sheet(wb, ws, data.sheetName || "Sheet1");
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
 *  - "KET_WPS_PIDS: <ids>"    → 本次新建的 WPS 进程（Node 端 finally 清理残留）
 *  - "KET_JSON_START..END"    → 提取数据（紧凑行协议），Node 端重建
 *  - "KET_ERROR: <msg>" + 退出码 20=密码问题 / 21=其他 COM 错误
 * 退出码 0 表示脚本正常完成（含两种成功路径）。
 *
 * 性能铁律（2026-08-17 实测）：
 *  - 绝不对 COM 返回的 2D 数组做 `$arr[$r,$c]` 逐格索引（PS 反射慢路径，分钟级
 *    挂死）；必须一次性 foreach 展平为 1D 再索引。
 *  - 绝不用 ConvertTo-Json -Depth N 序列化大嵌套数组（PS 5.1 极慢）；用
 *    StringBuilder 输出紧凑行协议。
 *  - 工作表级 COM（$ws.Activate/$ws.Range）在 WPS 365 受限环境被拒
 *    （E_ACCESSDENIED），只能读 Application 级活动工作表。
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
      # 无密码时也要显式传第 5 参（空串）：WPS 对需密码文件在缺参时会弹
      # 「文档已加密」模态框阻塞（DisplayAlerts 抑制不了）；传空串则快速抛错
      return $ket.Workbooks.Open($SourcePath, 0, $true, 5, '')
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

  # 协议文本转义（全 string 重载；String.raw 不处理反引号，故用 [char] 常量）
  function EscS($s) {
    if ($null -eq $s) { return '' }
    $t = [string]$s
    if ($t.IndexOf('\') -ge 0 -or $t.IndexOf([char]9) -ge 0 -or $t.IndexOf([char]10) -ge 0 -or $t.IndexOf([char]13) -ge 0) {
      $t = $t.Replace('\','\\')
      $t = $t.Replace([string][char]9,'\t')
      $t = $t.Replace([string][char]10,'\n')
      $t = $t.Replace([string][char]13,'\r')
    }
    return $t
  }

  $wb = OpenWb
  if ($wb -eq $null) { throw "Failed to open workbook" }

  # 记录本次新建的 WPS 进程（Node 端 finally 清理，防超时残留阻塞后续调用）
  $prePids = @{}
  Get-Process et,wps -ErrorAction SilentlyContinue | ForEach-Object { $prePids[$_.Id] = $true }
  $newPids = @()
  Get-Process et,wps -ErrorAction SilentlyContinue | ForEach-Object {
    if (-not $prePids.ContainsKey($_.Id)) { $newPids += $_.Id }
  }
  if ($newPids.Count -gt 0) { Write-Output ("KET_WPS_PIDS: " + ($newPids -join ',')) }

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

  # ---- 2) SaveAs 失败或产出 TSD → COM 提取活动表数据（快速版）----
  if ($wb -eq $null) { $wb = OpenWb }
  if ($wb -eq $null) { throw "Failed to reopen workbook" }

  $sheetsTotal = 1
  try { $sheetsTotal = [int]$wb.Sheets.Count } catch { }
  $sheetName = ''
  try { $sheetName = [string]$wb.ActiveSheet.Name } catch { }

  $lc = $ket.Cells.SpecialCells(11)
  $rows = [int]$lc.Row
  $cols = [int]$lc.Column
  if ($rows -lt 1) { $rows = 1 }
  if ($cols -lt 1) { $cols = 1 }
  if ($rows * $cols -gt 2000000) { $rows = [Math]::Floor(2000000 / $cols); if ($rows -lt 1) { $rows = 1 } }
  $addr = "A1:" + (ColLetter $cols) + $rows

  $values = $null
  $formulas = $null
  try { $values = $ket.Range($addr).Value2 } catch { }
  try { $formulas = $ket.Range($addr).Formula } catch { }

  # 展平 2D → 1D（foreach 枚举快；绝不用 $arr[$r,$c] 逐格索引）。
  # 注意：WPS 的 Range($addr).Value2 实际维度可能 ≠ SpecialCells 报告的行列
  # （实测 69x20 的 addr 返回 69x46 数组）——网格以数组实际维度为准，防越界。
  $gridRows = $rows
  $gridCols = $cols
  $vFlat = $null
  if ($values -is [Array]) {
    if ($values.Rank -eq 2) {
      $gridRows = $values.GetLength(0); $gridCols = $values.GetLength(1)
    } elseif ($rows -eq 1) { $gridCols = $values.Length }
    else { $gridRows = $values.Length }
    $n = $gridRows * $gridCols
    if ($n -gt 2000000) { if ($gridCols -ge 1) { $gridRows = [Math]::Floor(2000000 / $gridCols); if ($gridRows -lt 1) { $gridRows = 1 }; $n = $gridRows * $gridCols } }
    $vFlat = New-Object object[] $n
    $k = 0
    foreach ($v in $values) { if ($k -ge $n) { break }; $vFlat[$k] = $v; $k++ }
  } elseif ($null -ne $values) {
    # 单格标量
    $n = $gridRows * $gridCols
    $vFlat = New-Object object[] $n
    $vFlat[0] = $values
  } else {
    $n = $gridRows * $gridCols
  }
  $fFlat = $null
  if ($null -ne $formulas -and $n -gt 0) {
    $fFlat = New-Object string[] $n
    $k = 0
    foreach ($f in $formulas) { if ($k -ge $n) { break }; $fs2 = $f; if ($null -ne $fs2) { $fFlat[$k] = [string]$fs2 }; $k++ }
  }

  $sb = New-Object System.Text.StringBuilder 4194304
  [void]$sb.AppendLine("SHEETS|" + $sheetsTotal)
  $escName = EscS $sheetName
  [void]$sb.AppendLine("META|" + $gridRows + "|" + $gridCols + "|" + $escName)

  for ($r = 0; $r -lt $gridRows; $r++) {
    $base = $r * $gridCols
    for ($c = 0; $c -lt $gridCols; $c++) {
      if ($c -gt 0) { [void]$sb.Append([char]9) }
      $v = $vFlat[$base + $c]
      if ($null -eq $v) { [void]$sb.Append('E') }
      elseif ($v -is [datetime]) {
        [void]$sb.Append('D:' + ([double]$v.ToOADate()).ToString('R',[System.Globalization.CultureInfo]::InvariantCulture))
      }
      elseif ($v -is [double] -or $v -is [single] -or $v -is [int] -or $v -is [long] -or $v -is [decimal]) {
        [void]$sb.Append('N:' + ([double]$v).ToString('R',[System.Globalization.CultureInfo]::InvariantCulture))
      }
      elseif ($v -is [bool]) { [void]$sb.Append('B:' + ([string]$v).ToLowerInvariant()) }
      else { [void]$sb.Append('S:' + (EscS $v)) }
    }
    [void]$sb.AppendLine()
  }
  [void]$sb.AppendLine('ENDVALUES')

  # 稀疏公式（只写有公式的格）
  $anyF = $false
  for ($r = 0; $r -lt $gridRows; $r++) {
    $base = $r * $gridCols
    for ($c = 0; $c -lt $gridCols; $c++) {
      $f = $fFlat[$base + $c]
      if ($null -ne $f -and $f.Length -gt 0 -and $f.StartsWith('=')) {
        if (-not $anyF) { [void]$sb.AppendLine('FORMULAS'); $anyF = $true }
        $escF = EscS $f
        [void]$sb.Append($r); [void]$sb.Append(','); [void]$sb.Append($c); [void]$sb.Append(','); [void]$sb.AppendLine($escF)
      }
    }
  }

  # 列宽 / 行高（Application 级；跳过默认值以减小体积）
  $sb2 = New-Object System.Text.StringBuilder 512
  for ($c = 1; $c -le $gridCols; $c++) {
    try {
      $w = $ket.Columns.Item($c).ColumnWidth
      if ($null -ne $w -and $w -gt 0 -and [Math]::Abs($w - 8.38) -gt 0.05) {
        [void]$sb2.Append($c); [void]$sb2.Append('='); [void]$sb2.Append($w); [void]$sb2.Append(',')
      }
    } catch { }
  }
  $sb3 = New-Object System.Text.StringBuilder 2048
  for ($r = 1; $r -le [Math]::Min($gridRows, 2000); $r++) {
    try {
      $h = $ket.Rows.Item($r).RowHeight
      if ($null -ne $h -and $h -gt 0 -and [Math]::Abs($h - 15) -gt 0.1) {
        [void]$sb3.Append($r); [void]$sb3.Append('='); [void]$sb3.Append($h); [void]$sb3.Append(',')
      }
    } catch { }
  }

  # 合并区域（MergeCells 可能是 DBNull/标量/数组；数组先展平再 1D 块跳过）
  $mergeFlags = $null
  try { $mergeFlags = $ket.Range($addr).MergeCells } catch { }
  $sb4 = New-Object System.Text.StringBuilder 512
  $isArr = $mergeFlags -is [Array]
  $mFlat = $null
  if ($isArr -and $n -gt 0) {
    $mFlat = New-Object bool[] $n
    $k = 0
    foreach ($mv in $mergeFlags) { if ($k -ge $n) { break }; $mFlat[$k] = [bool]$mv; $k++ }
  }
  if ($null -ne $mFlat) {
    for ($r = 0; $r -lt $gridRows; $r++) {
      for ($c = 0; $c -lt $gridCols; $c++) {
        if ($mFlat[$r * $gridCols + $c]) {
          $above = ($r -gt 0) -and $mFlat[($r - 1) * $gridCols + $c]
          $left = ($c -gt 0) -and $mFlat[$r * $gridCols + ($c - 1)]
          if (-not $above -and -not $left) {
            $cellRef = (ColLetter ($c + 1)) + ($r + 1)
            $area = $ket.Range($cellRef).MergeArea
            $mr = [int]$area.Rows.Count
            $mc = [int]$area.Columns.Count
            [void]$sb4.Append($r); [void]$sb4.Append(','); [void]$sb4.Append($c); [void]$sb4.Append(','); [void]$sb4.Append($mr); [void]$sb4.Append(','); [void]$sb4.Append($mc); [void]$sb4.Append(';')
            if ($mc -gt 1) { $c += $mc - 1 }
            if ($mr -gt 1) { $r += $mr - 1; break }
          }
        }
      }
    }
  }

  Write-Output "KET_JSON_START"
  Write-Output ("COLW|" + $sb2.ToString())
  Write-Output ("ROWH|" + $sb3.ToString())
  Write-Output ("MERGES|" + $sb4.ToString())
  [Console]::Write($sb.ToString())
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
