import { existsSync } from "fs";
import { decryptViaKet, detectSpreadsheetKind } from "./ket-bridge";

/**
 * 把「工作簿源文件」解析成**外部工具（univer CLI / SheetJS）真能打开**的路径。
 *
 * 企业透明加解密驱动（TSD / 亿赛通 / IP-guard 类）会把受保护目录里的 .xlsx 变成
 * `%TSD-Header-###%` 容器：WPS/Excel 双击能开（驱动给可信进程内核层解密），但
 * univer CLI、SheetJS 这类普通进程读到的就是密文，报
 * 「End-of-central-directory signature not found」。
 *
 * CLI 只能读磁盘上的路径（不像查看器可以直接收内存明文），所以这里必须拿到一个
 * 解密产物文件。解密本身在 decryptViaKet 里完成：先走本机 TSD 内存解密（毫秒级、
 * 不依赖 WPS/Java，见 lib/tsd-decrypt.ts），拿不到再回退 WPS KET COM。
 */
export type ResolvedWorkbook = {
  /** 外部工具可直接打开的路径（未加密时等于入参） */
  path: string;
  /** true = 走了解密，path 是解密产物 */
  decrypted: boolean;
  /** 需要打开密码（调用方据此提示用户） */
  needPassword?: boolean;
  /** 解不开时的原因 */
  error?: string;
};

export async function resolveWorkbookPath(filePath: string, password?: string): Promise<ResolvedWorkbook> {
  const source = filePath.replace(/\\/g, "/");
  if (detectSpreadsheetKind(source) !== "encrypted") {
    return { path: source, decrypted: false };
  }
  const result = await decryptViaKet(source, { password });
  if (result.ok && result.outPath && existsSync(result.outPath)) {
    return { path: result.outPath.replace(/\\/g, "/"), decrypted: true };
  }
  const needPassword = result.code === "KET_PASSWORD_REQUIRED" || result.code === "KET_PASSWORD_WRONG";
  return {
    path: source,
    decrypted: false,
    needPassword,
    error: result.error ?? `解密失败（${result.code ?? "UNKNOWN"}）`,
  };
}
