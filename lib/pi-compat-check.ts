import { readFileSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";

/**
 * pi 引擎（@earendil-works/pi-coding-agent）与 pi-studio 的兼容性自检。
 *
 * 这个模块刻意保持**自包含**（不 import 任何项目内其他模块、不用 TS 特有语法），
 * 这样它既可以：
 *  1. 被 Next 打包进服务端（rpc-manager 的 PlainTextTheme 从这里拿颜色表）；
 *  2. 被 node 直接以 strip-types 方式在**子进程**里跑（升级后冒烟测试，
 *     用全新的模块缓存加载磁盘上的新 SDK，验证 pi-studio 依赖的 API 面没被改坏）。
 *
 * 背景：pi 0.83 → 0.84 时 Theme 构造函数新增了 `searchMatchText ?? text` /
 * `scrollbarThumb ?? selectedBg` 兜底，缺键时算出 undefined 导致 fgAnsi 抛
 * TypeError（/api/sessions 500）。tsc 查不出这类纯运行时破坏，所以要主动自检。
 */

// 主题 schema 里的全部前景/背景颜色键，全部置 ""（空串是合法“无色”值，
// fgAnsi/bgAnsi 会返回重置码）。pi >= 0.84 的 Theme 构造函数会无条件迭代
// 所有颜色键并做 `?? fallback` 兜底——缺 text/selectedBg 会算出 undefined 崩溃。
export const THEME_FG_KEYS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
  "muted", "dim", "text", "thinkingText", "searchMatchText",
  "userMessageText", "customMessageText", "customMessageLabel",
  "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder",
  "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
  "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable",
  "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
  "thinkingXhigh", "thinkingMax", "bashMode",
];
export const THEME_BG_KEYS = [
  "selectedBg", "scrollbarThumb", "searchMatchBg",
  "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
];
export const PLAIN_THEME_FG: Record<string, string> = Object.fromEntries(THEME_FG_KEYS.map((k) => [k, ""]));
export const PLAIN_THEME_BG: Record<string, string> = Object.fromEntries(THEME_BG_KEYS.map((k) => [k, ""]));

/** pi-studio 直接依赖的 pi-coding-agent 公开导出（全部应为函数） */
export const REQUIRED_SDK_EXPORTS = [
  "createAgentSessionFromServices",
  "createAgentSessionServices",
  "getAgentDir",
  "initTheme",
  "SessionManager",
  "ModelRuntime",
  "resolveModelScopeWithDiagnostics",
  "DefaultResourceLoader",
  "SettingsManager",
  "ProjectTrustStore",
  "hasTrustRequiringProjectResources",
] as const;

export interface PiCompatResult {
  ok: boolean;
  piVersion: string;
  errors: string[];
}

/** 读取 node_modules 中实际安装的 pi 版本 */
function getBundledPiVersion(): string {
  try {
    const pkgPath = join(resolve(process.cwd()), "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 校验当前进程能加载的 SDK 是否满足 pi-studio 的运行时假设：
 *  - 模块能动态导入；
 *  - 依赖的导出都在且是函数；
 *  - 用 pi-studio 同样的参数构造 Theme 不抛错（0.84 的坑）。
 * 不校验模型/网络等运行时行为。
 */
export async function checkPiCompat(): Promise<PiCompatResult> {
  const errors: string[] = [];
  const piVersion = getBundledPiVersion();
  let sdk: Record<string, unknown>;
  try {
    sdk = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      piVersion,
      errors: [`SDK import failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  for (const name of REQUIRED_SDK_EXPORTS) {
    if (typeof sdk[name] !== "function") {
      errors.push(`missing SDK export: ${name}`);
    }
  }
  const ThemeCtor = sdk.Theme as (new (...args: unknown[]) => unknown) | undefined;
  if (typeof ThemeCtor !== "function") {
    errors.push("missing SDK export: Theme");
  } else {
    try {
      // 与 lib/rpc-manager.ts 的 PlainTextTheme 完全相同的构造参数
      new ThemeCtor(PLAIN_THEME_FG, PLAIN_THEME_BG, "truecolor");
    } catch (error) {
      errors.push(`Theme construction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: errors.length === 0, piVersion, errors };
}

/** 兼容性冒烟测试的 node 命令行（在子进程里跑，加载磁盘上全新的 SDK） */
export function piCompatSmokeCommand(): { nodeArgs: string[] } {
  const compatPath = resolve(process.cwd(), "lib", "pi-compat-check.ts");
  const url = pathToFileURL(compatPath).href;
  return {
    nodeArgs: [
      "--input-type=module",
      "-e",
      `import("${url}")
        .then((m) => m.checkPiCompat())
        .then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); })
        .catch((e) => { console.error(String(e)); process.exit(2); });`,
    ],
  };
}
