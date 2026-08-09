import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { normalizeSlashes } from "./allowed-roots";
import { getDataDir } from "./storage-config";

/**
 * pi-studio 上传文件的隔离存储区。
 *
 * 所有手动上传的附件（.xlsx / .univer / 图片等）都存放在 pi-studio 项目目录下的
 * `pi-web-uploads/`（默认，可用配置/环境变量修改，见 lib/storage-config.ts），
 * 不再占用 pi 自身的数据目录（~/.pi/agent）。
 *
 * 容量管理：总量超过 MAX_UPLOADS_BYTES 时，按 mtime 从旧到新删除，直到低于上限。
 */

export const MAX_UPLOADS_BYTES = Number(process.env.PI_WEB_UPLOADS_MAX_BYTES ?? 300 * 1024 * 1024); // 默认 300MB，可用环境变量覆盖

export interface UploadEntry {
  name: string;
  /** Absolute path (normalized to forward slashes) — lets the UI open the file in the right panel. */
  path: string;
  size: number;
  mtimeMs: number;
  kind: "sheet" | "image" | "other";
}

/** 上传存储目录 = pi-web 数据目录（默认 <项目根>/pi-web-uploads，可配置）。 */
export function getUploadsDir(): string {
  return getDataDir();
}

export function getUploadKind(name: string): UploadEntry["kind"] {
  const ext = basename(name).toLowerCase().split(".").pop() ?? "";
  if (ext === "xlsx" || ext === "xls" || ext === "univer") return "sheet";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"].includes(ext)) return "image";
  return "other";
}

/** 文件名安全校验：禁止路径穿越与非法字符。 */
export function sanitizeUploadName(name: string): string | null {
  const base = basename(name);
  if (!base || base === "." || base === ".." || base.includes("\0")) return null;
  if (base.includes("/") || base.includes("\\")) return null;
  // Windows 文件名非法字符
  if (/[<>:"|?*]/.test(base)) return null;
  return base;
}

export function listUploads(): UploadEntry[] {
  const dir = getUploadsDir();
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .map((name) => {
        const full = join(dir, name);
        let size = 0;
        let mtimeMs = 0;
        try {
          const st = statSync(full);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          /* 文件可能刚被删除 */
        }
        return { name, path: normalizeSlashes(full), size, mtimeMs, kind: getUploadKind(name) };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // 新的在前
  } catch {
    return [];
  }
}

export function getUploadsStats(): { totalBytes: number; maxBytes: number; files: UploadEntry[]; dir: string } {
  const files = listUploads();
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  return { totalBytes, maxBytes: MAX_UPLOADS_BYTES, files, dir: getUploadsDir() };
}

/** 总量超限时按 mtime 从旧到新删除，直到低于上限。返回删除的文件名。 */
export function enforceQuota(): string[] {
  const dir = getUploadsDir();
  const files = listUploads();
  let total = files.reduce((sum, f) => sum + f.size, 0);
  const removed: string[] = [];
  // 从最旧开始删
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of files) {
    if (total <= MAX_UPLOADS_BYTES) break;
    try {
      rmSync(join(dir, f.name), { force: true });
      total -= f.size;
      removed.push(f.name);
    } catch {
      /* 跳过删除失败的文件 */
    }
  }
  return removed;
}

/**
 * 返回一个不重名的落盘路径（重名时自动追加 -1/-2 序号），不创建文件。
 * 用于需要先拿到目标路径再交给外部工具（如 univer import）写入的场景。
 */
export function reserveUploadPath(originalName: string): { name: string; path: string } {
  const safe = sanitizeUploadName(originalName);
  if (!safe) throw new Error(`Invalid file name: ${originalName}`);
  const dir = getUploadsDir();
  const [base, ...extParts] = safe.split(".");
  const ext = extParts.length ? `.${extParts.join(".")}` : "";
  let name = safe;
  let counter = 2;
  while (existsSync(join(dir, name))) {
    name = `${base}-${counter}${ext}`;
    counter += 1;
  }
  return { name, path: normalizeSlashes(join(dir, name)) };
}

/**
 * 写入一个上传文件。返回最终落盘的文件名（重名时自动追加 -1/-2 序号）。
 * 写入完成后执行容量清理。
 */
export function writeUpload(originalName: string, bytes: Buffer): { name: string; path: string; evicted: string[] } {
  const { name, path: full } = reserveUploadPath(originalName);
  writeFileSync(full, bytes, { flag: "wx" });
  return { name, path: full, evicted: enforceQuota() };
}

export function deleteUpload(name: string): boolean {
  const safe = sanitizeUploadName(name);
  if (!safe) return false;
  const full = join(getUploadsDir(), safe);
  if (!existsSync(full)) return false;
  rmSync(full, { force: true });
  return true;
}

export function getUploadPath(name: string): string | null {
  const safe = sanitizeUploadName(name);
  if (!safe) return null;
  const full = join(getUploadsDir(), safe);
  return existsSync(full) ? normalizeSlashes(full) : null;
}
