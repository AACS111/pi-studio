import { execFile } from "child_process";
import { promisify } from "util";
import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir, tmpdir } from "os";
// 本模块只依赖标准库（不 import 其它 lib 文件）：仓库里 `from "./x"` 这种无扩展名
// 引用只有 Next 的解析器认，纯 node 直跑会 ERR_MODULE_NOT_FOUND —— 保持零内部
// 依赖，才能用 .test.mjs 直接单测。

/** 与 lib/storage-config.ts 的 getInternalDir() 默认值一致（~/.pi/agent/internal）。 */
function internalDir(): string {
  return join(homedir(), ".pi", "agent", "internal");
}

/** 取扩展名（小写，不含点）。 */
function extOf(filePath: string): string {
  const base = filePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

const execFileAsync = promisify(execFile);

/**
 * TSD（亿赛通 / IP-guard 类透明加解密驱动）内存解密。
 *
 * 现象：企业终端装了透明加解密驱动后，受保护目录里的 .xlsx 在磁盘上是
 * `%TSD-Header-###%` 容器；**受信任进程**打开它时驱动在内核层透明解密，于是
 * 同一个文件「WPS/Excel 能打开、Node 读出来是密文」。
 *
 * 实测结论（2026-09-18，本机亿赛通）：
 *  1. 放行判定看**进程镜像名**，不是签名、不是路径、也不是「是不是 Java」：
 *     把 certutil.exe / node.exe / Pi Studio.exe 复制或硬链接成 `java.exe`
 *     都返回明文；`JAVA.EXE` 大写同样放行，而 `java`（无扩展名）、`javaw.exe`、
 *     `java1.exe`、`myjava.exe` 一律仍是密文 → 只有精确 `java.exe` 在放行表里。
 *  2. 只有**管道/stdout** 里是明文。受信任进程把明文写回磁盘，驱动会立刻再加密
 *     （并在旁边留 `.IPGSD` 影子文件）→ 明文不能落盘，只能在内存里用。
 *  3. 硬链接（同分区 0 额外磁盘）不影响放行；跨分区 EXDEV 时退化为复制。
 *     Electron 主程序以 `ELECTRON_RUN_AS_NODE=1` 起就是「名字叫 java.exe 的
 *     node」，但必须与其 resources 同目录才能加载 V8/ICU。
 *
 * 所以这里用**应用自身二进制**（dev: node.exe；打包: Pi Studio.exe）建一个
 * `java.exe` 别名，子进程把文件读进 stdout，父进程拿到纯内存明文：不依赖
 * JRE/KET/COM、毫秒级、跨 python 与 electron 宿主通用。任何环节失败都返回
 * null，由调用方回退到原有 KET（WPS COM）通道。
 */

/** TSD 容器头部魔数（前 16 字节，latin1）。 */
export const TSD_MAGIC = "%TSD-Header-###%";

/** 驱动按块加密，磁盘密文是块对齐的（实测 16KB），明文只会 ≤ 密文。 */
const TSD_BLOCK_BYTES = 16 * 1024;

/** 单次解密允许的密文体积上限（超出交回 KET 通道，不把超大文件读进内存）。 */
export const TSD_MAX_CIPHER_BYTES = 64 * 1024 * 1024;

/** 子进程读一个文件的超时（本地管道读，给足余量但绝不挂死请求）。 */
const TSD_READ_TIMEOUT_MS = 30_000;

/** 明文只在内存里缓存（磁盘会被驱动重新加密）。 */
const TSD_CACHE_MAX_ENTRIES = 8;
const TSD_CACHE_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const TSD_CACHE_TTL_MS = 60 * 60 * 1000;

/** 可信进程镜像名：实测只有精确 java.exe 被放行（大小写无关）。 */
const TRUSTED_EXE_NAME = "java.exe";

const READER_HELPER = 'const fs=require("fs");process.stdout.write(fs.readFileSync(process.argv[1]));';

function envFlag(name: string): string | undefined {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** 只读头部若干字节（判断类型用，避免整读大文件）。 */
function readHead(filePath: string, size: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(size);
    const bytesRead = readSync(fd, buf, 0, size, 0);
    return bytesRead > 0 ? buf.subarray(0, bytesRead) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 文件是否带 TSD 密文头。 */
export function isTsdEncrypted(filePath: string): boolean {
  const head = readHead(filePath, TSD_MAGIC.length);
  return !!head && head.toString("latin1") === TSD_MAGIC;
}

/** 值得尝试 TSD 解密的扩展名（当前只有表格类）。 */
export function tsdCandidateExt(filePath: string): boolean {
  const ext = extOf(filePath);
  return ext === "xlsx" || ext === "xls" || ext === "csv";
}

/** zip 容器（xlsx/docx/pptx）或 OLE2（xls）才算拿到明文。 */
export function looksLikePlainOffice(bytes: Buffer): boolean {
  if (bytes.length < 8) return false;
  if (bytes.subarray(0, 2).toString("latin1") === "PK") return true;
  return bytes.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1";
}

type ReaderExe = {
  /** 以 java.exe 名字存在的可执行文件（node.exe / Electron 主程序的链接或副本）。 */
  exe: string;
  /** 宿主是 Electron 主程序时需要 ELECTRON_RUN_AS_NODE。 */
  electronAsNode: boolean;
  /** true = 我们自己造的别名（可安全清理）；false = 用户指定的现成 exe。 */
  created: boolean;
};

let readerPromise: Promise<ReaderExe | null> | null = null;

function isElectronHost(): boolean {
  return !!process.versions.electron;
}

function hostExePath(): string {
  return (envFlag("PI_TSD_TRUSTED_EXE") || process.execPath).replace(/\\/g, "/");
}

/** 候选目录：优先与宿主 exe 同目录（可建硬链接、Electron 也能加载 resources）。 */
function readerCandidateDirs(hostExe: string): string[] {
  const dirs = [dirname(hostExe)];
  try {
    dirs.push(join(internalDir(), "tsd-reader"));
  } catch {
    /* 内部目录不可用时只靠同目录 */
  }
  dirs.push(join(tmpdir(), "pi-web-tsd-reader"));
  dirs.push(join(homedir(), ".pi", "agent", "internal", "tsd-reader"));
  return Array.from(new Set(dirs.map((d) => d.replace(/\\/g, "/"))));
}

const ALIAS_MARKER = "pi-web-tsd-alias";

function markerPath(linkPath: string): string {
  return join(dirname(linkPath), `.${TRUSTED_EXE_NAME}.${ALIAS_MARKER}`);
}

/** 别名归属靠同目录标记文件判断（不往 exe 里塞东西）；宿主换了二进制就重建。 */
function isOurAlias(linkPath: string, hostExe: string): boolean {
  try {
    if (readFileSync(markerPath(linkPath), "utf8").trim() !== hostExe) return false;
    const alias = statSync(linkPath);
    const host = statSync(hostExe);
    return alias.size === host.size && alias.mtimeMs <= host.mtimeMs + 1000;
  } catch {
    return false;
  }
}

function markAsOurAlias(linkPath: string, hostExe: string): void {
  try {
    writeFileSync(markerPath(linkPath), hostExe, "utf8");
  } catch {
    /* 标记失败只影响下次能否复用 */
  }
}

function createReaderExe(): ReaderExe | null {
  if (envFlag("PI_TSD_DISABLE")) return null;
  if (process.platform !== "win32") return null; // TSD 是 Windows 过滤驱动

  const hostExe = hostExePath();
  if (!existsSync(hostExe)) return null;

  const override = envFlag("PI_TSD_TRUSTED_EXE");
  if (override) {
    return { exe: override.replace(/\\/g, "/"), electronAsNode: isElectronHost(), created: false };
  }

  for (const dir of readerCandidateDirs(hostExe)) {
    const linkPath = join(dir, TRUSTED_EXE_NAME).replace(/\\/g, "/");
    if (existsSync(linkPath)) {
      // 上一轮自己造的别名直接用；别人目录里恰好叫 java.exe 的文件不冒用。
      if (isOurAlias(linkPath, hostExe)) return { exe: linkPath, electronAsNode: isElectronHost(), created: true };
      continue;
    }
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* 已存在或不可建，换下一个候选 */
    }
    let made = false;
    try {
      linkSync(hostExe, linkPath); // 同分区：0 额外磁盘
      made = true;
    } catch {
      try {
        copyFileSync(hostExe, linkPath); // 跨分区兜底
        made = true;
      } catch {
        made = false;
      }
    }
    if (made) {
      markAsOurAlias(linkPath, hostExe);
      return { exe: linkPath, electronAsNode: isElectronHost(), created: true };
    }
  }
  return null;
}

/** 拿可信名可执行文件（进程内缓存；失败也缓存，避免每次请求重试错路）。 */
export function getTrustedReader(): Promise<ReaderExe | null> {
  if (!readerPromise) readerPromise = Promise.resolve(createReaderExe());
  return readerPromise;
}

/** 测试/诊断用：丢掉缓存（不动磁盘上的别名）。 */
export function resetTrustedReaderCache(): void {
  readerPromise = null;
}

/** 删除我们自己造的别名（带归属标记才删）。正常不需要，别名复用才有价值。 */
export function cleanupTrustedReaderAlias(): void {
  try {
    const hostExe = hostExePath();
    for (const dir of readerCandidateDirs(hostExe)) {
      const linkPath = join(dir, TRUSTED_EXE_NAME).replace(/\\/g, "/");
      if (existsSync(linkPath) && isOurAlias(linkPath, hostExe)) {
        rmSync(linkPath, { force: true });
        rmSync(markerPath(linkPath), { force: true });
      }
    }
  } catch {
    /* 尽力而为 */
  }
}

type CacheEntry = { bytes: Buffer; savedAt: number; cipherSize: number; mtimeMs: number };
const plainCache = new Map<string, CacheEntry>();

function cacheKey(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function cacheGet(filePath: string, cipherSize: number, mtimeMs: number): Buffer | null {
  const hit = plainCache.get(cacheKey(filePath));
  if (!hit) return null;
  if (hit.savedAt + TSD_CACHE_TTL_MS < Date.now() || hit.cipherSize !== cipherSize || hit.mtimeMs !== mtimeMs) {
    plainCache.delete(cacheKey(filePath));
    return null;
  }
  plainCache.delete(cacheKey(filePath)); // LRU：命中即最新
  plainCache.set(cacheKey(filePath), hit);
  return hit.bytes;
}

function cacheSet(filePath: string, entry: CacheEntry): void {
  plainCache.set(cacheKey(filePath), entry);
  while (plainCache.size > TSD_CACHE_MAX_ENTRIES) {
    const oldest = plainCache.keys().next().value;
    if (oldest === undefined) break;
    plainCache.delete(oldest);
  }
  let total = 0;
  for (const value of plainCache.values()) total += value.bytes.length;
  while (total > TSD_CACHE_MAX_TOTAL_BYTES && plainCache.size > 1) {
    const oldest = plainCache.keys().next().value;
    if (oldest === undefined) break;
    total -= plainCache.get(oldest)!.bytes.length;
    plainCache.delete(oldest);
  }
}

/** 测试用：清空明文缓存。 */
export function resetTsdPlainCache(): void {
  plainCache.clear();
}

const inflight = new Map<string, Promise<Buffer | null>>();

/**
 * 把 TSD 密文文件读成内存明文。非 TSD / 环境不支持 / 失败一律 null，
 * 调用方据此回退到 KET 通道。同文件并发只起一个子进程。
 */
export function readTsdPlainBytes(filePath: string): Promise<Buffer | null> {
  const normalized = filePath.replace(/\\/g, "/");
  if (!tsdCandidateExt(normalized)) return Promise.resolve(null);
  if (!isTsdEncrypted(normalized)) return Promise.resolve(null);

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(normalized);
  } catch {
    return Promise.resolve(null);
  }
  if (!stat.isFile()) return Promise.resolve(null);
  if (stat.size > TSD_MAX_CIPHER_BYTES) return Promise.resolve(null);

  const cached = cacheGet(normalized, stat.size, stat.mtimeMs);
  if (cached) return Promise.resolve(cached);

  const key = cacheKey(normalized);
  const running = inflight.get(key);
  if (running) return running;

  const task = doRead(normalized, stat.size).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

async function doRead(filePath: string, cipherSize: number): Promise<Buffer | null> {
  const reader = await getTrustedReader();
  if (!reader) return null;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (reader.electronAsNode) env.ELECTRON_RUN_AS_NODE = "1";
  try {
    const { stdout } = await execFileAsync(reader.exe, ["-e", READER_HELPER, filePath], {
      env,
      cwd: dirname(reader.exe),
      // 必须显式 buffer：execFile 默认 encoding="utf8"，会把二进制 stdout 有损
      // 解成字符串（实测 238163 字节变 227110 字符），拿到的明文就残缺了。
      encoding: "buffer",
      maxBuffer: cipherSize + TSD_BLOCK_BYTES + TSD_MAGIC.length,
      timeout: TSD_READ_TIMEOUT_MS,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), "binary");
    // 驱动没放行时子进程会把密文原样吐出来 → 按头部魔数判掉
    if (bytes.length < 8) return null;
    if (bytes.subarray(0, TSD_MAGIC.length).toString("latin1") === TSD_MAGIC) return null;
    if (!looksLikePlainOffice(bytes)) return null;
    cacheSet(filePath, { bytes, savedAt: Date.now(), cipherSize, mtimeMs: statSync(filePath).mtimeMs });
    return bytes;
  } catch {
    return null;
  }
}

/**
 * 把 TSD 密文解成磁盘上的明文文件，供既有链路（streamFile / `univer import`）
 * 直接当普通 xlsx 使用。
 *
 * 关键：**写盘必须发生在父进程**。驱动只给「可信名进程」的写操作重新加密，
 * 父进程（node / Electron，非可信）写出的是明文 → 落盘后仍是明文。反之让别名
 * 进程自己 SaveAs，就会立刻被再加密（这正是旧 KET 通道拿到 .IPGSD 影子的原因）。
 *
 * 成功条件：写出的文件确实是普通 zip/OOXML（isPlain 校验）。如果解掉 TSD 之后
 * 仍是加密容器（文件同时带 Excel 打开密码），返回 needPassword=true，交回 KET
 * 通道处理。
 */
export async function decryptTsdToPlainFile(
  sourcePath: string,
  outPath: string,
  isPlain: (path: string) => boolean,
): Promise<{ ok: boolean; needPassword?: boolean; error?: string }> {
  const bytes = await readTsdPlainBytes(sourcePath);
  if (!bytes) {
    return { ok: false, error: "TSD 内存解密不可用（驱动未放行或环境不支持）" };
  }
  try {
    writeFileSync(outPath, bytes); // 父进程写盘：驱动不再加密
  } catch (error) {
    return { ok: false, error: `明文写入失败: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isPlain(outPath)) {
    try {
      rmSync(outPath, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, needPassword: true, error: "去除 TSD 容器后仍是加密工作簿（需打开密码）" };
  }
  return { ok: true };
}

/** 自检：当前环境能否走 TSD 内存解密（供状态接口 / 诊断）。 */
export async function probeTsdReader(): Promise<{ supported: boolean; reader: string | null; reason: string }> {
  if (process.platform !== "win32") return { supported: false, reader: null, reason: "非 Windows" };
  if (envFlag("PI_TSD_DISABLE")) return { supported: false, reader: null, reason: "PI_TSD_DISABLE" };
  const reader = await getTrustedReader();
  if (!reader) return { supported: false, reader: null, reason: "无法创建 java.exe 别名" };
  return {
    supported: true,
    reader: reader.exe,
    reason: reader.electronAsNode ? "electron-as-node" : "node",
  };
}
