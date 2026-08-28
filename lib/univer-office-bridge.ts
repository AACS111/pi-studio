import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { getInternalDir } from "@/lib/storage-config";

/**
 * Office→Univer 桥的「源文件 → 已转换 .univer」复用注册表。
 *
 * 办公文档（.xlsx/.csv/.docx/.pptx 等）经 /api/univer/from-xlsx 转成上传目录里的
 * `<basename>-ai-edit.univer` 后由右侧 UniverFileViewer 打开。这个转换是自动触发的
 * （点变更卡片/任务区卡片就会走），所以必须能识别"同一个源文件已经转过一次"，
 * 直接返回已有目标，否则每次打开都会在数据目录里堆一份新副本。
 *
 * 注册表按 源绝对路径(归一化键) → { target, sourceMtimeMs, sourceSize } 存储；
 * 源文件的 mtime+size 都没变 且 target 仍存在 → 命中复用；任一变化 → 重新导入并覆盖记录。
 */

const REGISTRY_NAME = "univer-office-bridge.json";

interface BridgeRecord {
  /** 转换产物（uploads 目录下的绝对路径，正斜杠） */
  target: string;
  sourceMtimeMs: number;
  sourceSize: number;
}

type Registry = Record<string, BridgeRecord>;

function registryPath(): string {
  return join(getInternalDir(), REGISTRY_NAME);
}

/** 归一化注册表键：正斜杠 + Windows 下小写（NTFS 不区分大小写）。 */
export function bridgeRegistryKey(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readRegistry(): Registry {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Registry;
    }
  } catch {
    /* 首次使用 / 文件损坏 → 视为空 */
  }
  return {};
}

function writeRegistry(registry: Registry): void {
  try {
    // 目录可能刚被清理（测试/手动）——确保存在，否则静默失败会让映射丢失
    mkdirSync(getInternalDir(), { recursive: true });
    writeFileSync(registryPath(), JSON.stringify(registry, null, 2));
  } catch {
    /* 注册表写失败不影响主流程 —— 只是下次会多做一次导入 */
  }
}

/** 读源文件的 mtime+size 快照；读不到（刚被删）返回 null。 */
function sourceStat(sourcePath: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(sourcePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * 若源文件已转换过且内容未变、产物仍在 → 返回已知的 target（可复用）。
 * 否则返回 null，调用方应执行一次新导入并在完成后调用 rememberBridgeTarget()。
 */
export function resolveReusedBridge(sourcePath: string): string | null {
  const record = readRegistry()[bridgeRegistryKey(sourcePath)];
  if (!record?.target) return null;
  if (!existsSync(record.target)) return null;
  const st = sourceStat(sourcePath);
  if (!st) return null;
  if (st.mtimeMs !== record.sourceMtimeMs || st.size !== record.sourceSize) return null;
  return record.target;
}

/** 记录一次成功导入的映射（之后同样内容的源会直接复用该 target）。 */
export function rememberBridgeTarget(sourcePath: string, target: string): void {
  const st = sourceStat(sourcePath);
  if (!st) return; // 源都不可读了没必要记
  const registry = readRegistry();
  registry[bridgeRegistryKey(sourcePath)] = {
    target: target.replace(/\\/g, "/"),
    sourceMtimeMs: st.mtimeMs,
    sourceSize: st.size,
  };
  writeRegistry(registry);
}

/**
 * 反查：给定转换产物（ai-edit .univer）路径，返回它对应的原始文档路径。
 * 供写回原件（/api/univer/writeback）定位真正的原件——产物固定叫
 * `<basename>-ai-edit.univer` 且落在数据目录，按扩展名猜原件路径必然 404。
 * 不校验 source mtime/size：写回允许原件在转换后被外部改过（用户手动编辑）。
 */
export function resolveBridgeSource(targetPath: string): string | null {
  const normalizedTarget = targetPath.replace(/\\/g, "/").toLowerCase();
  for (const [sourceKey, record] of Object.entries(readRegistry())) {
    if (record?.target && record.target.toLowerCase() === normalizedTarget) {
      // key 就是归一化后的源路径（bridgeRegistryKey）
      return sourceKey;
    }
  }
  return null;
}
