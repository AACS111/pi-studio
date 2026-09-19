#!/usr/bin/env node
/**
 * 阶段 4：静态设计自检——**不截图、不调模型、无网络**，毫秒级。
 *
 * 为什么要它：视觉模型评审又慢又挑模型（实测 kimi 两次 100+ 秒并撞网关 504，
 * 且并非所有模型支持图片输入）。而文章里那句「截图不会告诉你字体尺寸差了 5px，
 * 但规则会」正好说明：**能算的缺陷不该靠眼睛判**。本脚本把这些缺陷变成确定性检查：
 *   1. WCAG 对比度：从 token 值直接算，比人眼和模型目测都准
 *      （本项目踩过一次：#6B7280/#F7F8FA 看着正常，算出来 3.88 不达 AA）；
 *   2. token 违约：组件里手写的 #hex / rgb() / 半档字号 / blur / box-shadow / 圆角；
 *   3. 尺寸节奏：同一组件内相邻元素的字号、圆角、内边距是否落在刻度上、是否共享节奏。
 *
 * 用法：
 *   node static-check.mjs [--files components,app] [--tokens app/globals.css]
 *                         [--design DESIGN.md] [--bg <玻璃实测底色>] [--json] [--strict]
 * 退出码：0 全通过 / 1 有 P0（对比度不达标或 token 违约）
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const ROOT = process.cwd();

const KNOWN_FLAGS = new Set(["--files", "--tokens", "--design", "--bg", "--checks", "--json", "--strict", "--help"]);

function parseArgs(argv) {
  const o = { json: false, strict: false, files: [], checks: ["contrast", "tokens", "rhythm"] };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    // 裸参数（如 `--files app components` 里的 components）以前会被**静默忽略**，
    // 扫了 1 个目录还以为扫了 2 个，是最坑的错法。一律报错退出。
    if (a.startsWith("--") && !KNOWN_FLAGS.has(a)) { unknown.push(a); continue; }
    if (!a.startsWith("--") && i > 0 && argv[i - 1] !== "--files" && !argv[i - 1].startsWith("--")) unknown.push(a);
    if (a === "--files") o.files = String(next()).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--tokens") o.tokens = next();
    else if (a === "--design") o.design = next();
    else if (a === "--bg") o.bg = next();
    else if (a === "--checks") o.checks = String(next()).split(",").map((s) => s.trim());
    else if (a === "--json") o.json = true;
    else if (a === "--strict") o.strict = true;
    else if (a === "--help") { o.help = true; }
  }
  o.unknown = unknown;
  return o;
}

/* ───────────── 颜色与 WCAG ───────────── */

/** 解析 #hex / rgb() / rgba() → { r,g,b,a }；解析失败返回 null。 */
export function parseColor(str) {
  const s = String(str).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    const v = (i) => parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return { r: v(0), g: v(1), b: v(2), a: h.length >= 8 ? v(3) / 255 : 1 };
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean);
    const nums = parts.map((p) => (p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p)));
    const [r, g, b, a] = nums;
    if (![r, g, b].every(Number.isFinite)) return null;
    // 百分比形式（rgb(50% 50% 50%)）换算成 0-255
    const chan = (v) => (parts[0].endsWith("%") ? v * 255 : v);
    return { r: chan(r), g: chan(g), b: chan(b), a: Number.isFinite(a) ? a : 1 };
  }
  return null;
}

/** 前置色按 alpha 合成到背景色上（透明色必须给底色才能算对比度）。 */
export function composite(fg, bg) {
  if (!fg) return null;
  const a = fg.a ?? 1;
  if (a >= 1 || !bg) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

const relLuminance = ({ r, g, b }) => {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** WCAG 2.x 对比度比值（1–21）。 */
export function contrastRatio(fgStr, bgStr) {
  const bg = parseColor(bgStr);
  const fg = composite(parseColor(fgStr), bg);
  if (!fg || !bg) return null;
  const l1 = relLuminance(fg), l2 = relLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
}

/** AA 阈值：≥24px 或 ≥18.66px 且字重 ≥700 属「大字」→ 3.0，否则 4.5。 */
function aaThreshold(px, weight) {
  const bold = Number(weight) >= 700;
  if (px >= 24 || (px >= 18.66 && bold)) return 3.0;
  return 4.5;
}

/* ───────────── token 抽取 ───────────── */

/** 从 CSS 里抽 :root / @theme / html.dark 的自定义属性（值可为 hex / rgba / var 引用）。 */
export function extractCssVars(css) {
  const out = new Map();
  const blockRe = /(:root|html\.dark|@theme)\s*\{([^}]*)\}/g;
  let m;
  while ((m = blockRe.exec(css)) !== null) {
    const scope = m[1] === "html.dark" ? "dark" : "light";
    for (const line of m[2].split("\n")) {
      const d = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
      if (!d) continue;
      const name = d[1], value = d[2].trim();
      const rec = out.get(name) || { light: null, dark: null };
      rec[scope] = value;
      out.set(name, rec);
    }
  }
  return out;
}

/** 沿 var() 引用链解析到可用于算对比度的实色（最多 6 跳，避开循环）。 */
function resolveColor(name, vars, scope, seen = new Set()) {
  if (seen.has(name) || seen.size > 6) return null;
  seen.add(name);
  const rec = vars.get(name);
  let raw = rec ? (rec[scope] || rec.light || rec.dark) : null;
  if (!raw) return null;
  for (let hop = 0; hop < 6; hop++) {
    if (/^#[0-9a-f]{3,8}$/i.test(raw.trim()) || /^rgba?\(/i.test(raw.trim())) return raw.trim();
    const inner = raw.match(/var\(\s*(--[\w-]+)/);
    if (!inner) return null;
    const next = resolveColor(inner[1], vars, scope, seen);
    if (!next) return null;
    raw = next;
  }
  return null;
}

function findTokenFile(explicit) {
  const cands = explicit
    ? [explicit, join(ROOT, explicit)]
    : ["app/globals.css", "src/globals.css", "app/globals.scss", "styles/globals.css", "globals.css"];
  for (const c of cands) if (c && existsSync(resolve(ROOT, c))) return resolve(ROOT, c);
  return null;
}

/** 展开 --files 的简易 glob（只支持目录递归与 *.ext 后缀匹配）。 */
function collectFiles(patterns) {
  const exts = [".tsx", ".jsx", ".ts", ".js", ".css", ".scss", ".vue", ".html", ".svelte"];
  const dirs = [];
  const exact = [];
  for (const p of patterns || []) {
    const abs = resolve(ROOT, p.replace(/\*\*.*$/, "").replace(/\*.*$/, "").replace(/[\\/]$/, "") || ".");
    if (!existsSync(abs)) continue;
    if (statSync(abs).isFile()) exact.push(abs);
    else dirs.push(abs);
  }
  if (patterns.length === 0) {
    for (const d of ["app", "components", "src", "lib", "hooks"]) {
      const abs = resolve(ROOT, d);
      if (existsSync(abs)) dirs.push(abs);
    }
  }
  const files = [...exact];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (exts.some((e) => name.endsWith(e)) && !/\.(test|spec|stories)\./.test(name)) files.push(p);
    }
  };
  for (const d of dirs) walk(d, 0);
  return files;
}

/* ───────────── 三项检查 ───────────── */

const TEXT_TOKENS = ["--text", "--text-muted", "--text-dim"];
const BG_TOKENS = ["--bg", "--bg-panel", "--bg-elevated", "--bg-sunken"];

function checkContrast(vars, opts) {
  const findings = [];
  // 玻璃/半透明底实测色优先用 --bg（用户可 --bg 覆盖成真实观察到的底色）
  for (const scope of ["light", "dark"]) {
    const bgs = (opts.bg ? [opts.bg] : BG_TOKENS.map((t) => resolveColor(t, vars, scope)).filter(Boolean));
    if (bgs.length === 0) continue;
    for (const token of TEXT_TOKENS) {
      const fgRaw = resolveColor(token, vars, scope);
      if (!fgRaw) continue;
      for (const bg of bgs) {
        const ratio = contrastRatio(fgRaw, bg);
        if (ratio == null) continue;
        const need = 4.5; // 正文档：小字必须 4.5；大字 3.0 视为可接受下限
        if (ratio < need) {
          findings.push({
            id: `C${findings.length + 1}`, severity: ratio < 3 ? "P0" : "P1",
            region: `${token} on ${bg}`,
            symptom: `对比度 ${ratio}:1（AA 小字需 ≥ ${need}:1）`,
            cause: `${scope === "dark" ? "深色" : "浅色"}模式下该文字档太浅/底色太深`,
            fix: `加深 ${token} 或改底色；无法改底色时用字重 ≥700 + 更大字号换取 3:1 档`,
            confidence: 1,
          });
        }
      }
    }
  }
  return findings;
}

const RULES = [
  { key: "hex", re: /(?:color|background|background-color|border-color)\s*:\s*(#[0-9a-fA-F]{3,8})/g,
    sev: "P1", what: "硬编码色值", hint: "改 var(--token)；确无对应 token 时先补进 DESIGN.md" },
  { key: "rgba", re: /(?:color|background|background-color|border-color|box-shadow)\s*:\s*(rgba?\([^)]*\))/g,
    sev: "P2", what: "硬编码 rgb/rgba", hint: "已有 token 就换；半透明叠层用 rgba(var(--accent-rgb), α) 这类通道变量" },
  { key: "blur", re: /backdrop-filter\s*:\s*blur\((\d+(?:\.\d+)?)px\)/g,
    sev: "P1", what: "手写 backdrop blur", hint: "统一引用 --glass-blur，否则浮层质感会分叉" },
  { key: "shadow", re: /box-shadow\s*:\s*(0[^;]*rgba?\([^)]*\))/g,
    sev: "P2", what: "手写阴影", hint: "改用 --shadow-xs/sm/md/lg" },
  { key: "radius", re: /border-radius\s*:\s*(\d+(?:\.\d+)?)px/g,
    sev: "P2", what: "圆角", hint: "改用 --radius-xs/sm/md/lg/xl 阶梯" },
  { key: "fontsize", re: /font-size\s*:\s*(\d+(?:\.\d+)?)px/g,
    sev: "P2", what: "字号", hint: "收敛到 DESIGN.md 字阶，禁止新增半档（10.5/11.5/12.5/13.5）" },
  { key: "tw-arbitrary", re: /\b(?:text|bg|border|p|m|gap|rounded)-\[[^\]]+\]/g,
    sev: "P2", what: "Tailwind 任意值", hint: "落回 token 或用刻度类（text-xs / p-2 / rounded-md）" },
];
const HALF_STEPS = new Set([10.5, 11.5, 12.5, 13.5]);
const RADIUS_STEPS = new Set([6, 8, 10, 14, 18, 16, 999]);

function checkTokens(files) {
  const findings = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    // CSS 里的 token 定义本身允许写字面色值，跳过 :root/@theme 块
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      if (/^\s*--[\w-]+\s*:/.test(line)) return;          // token 定义行
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line.trim())) return; // 注释
      for (const rule of RULES) {
        rule.re.lastIndex = 0;
        const m = rule.re.exec(line);
        if (!m) continue;
        let sev = rule.sev, extra = "";
        if (rule.key === "fontsize" && HALF_STEPS.has(Number(m[1]))) { sev = "P1"; extra = "（半档字号）"; }
        if (rule.key === "radius" && !RADIUS_STEPS.has(Number(m[1]))) { sev = "P1"; extra = "（阶梯外圆角）"; }
        findings.push({
          id: `T${findings.length + 1}`, severity: sev,
          region: `${rel}:${idx + 1}`,
          symptom: `${rule.what}${extra}：${m[0].trim().slice(0, 72)}`,
          cause: "绕过 DESIGN.md 的 token 契约，同类元素会逐次漂移",
          fix: rule.hint,
          confidence: 1,
        });
      }
    });
  }
  return findings;
}

/** 字号节奏：同一文件里出现的字号集合是否失控（>6 档即提示收敛）。 */
function checkRhythm(files) {
  const findings = [];
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (!/\.(css|scss)$/.test(rel)) continue;
    const text = readFileSync(file, "utf8");
    const sizes = new Set();
    let m; const re = /font-size:\s*(\d+(?:\.\d+)?)px/g;
    while ((m = re.exec(text)) !== null) sizes.add(Number(m[1]));
    if (sizes.size <= 6) continue;
    const sorted = [...sizes].sort((a, b) => a - b);
    findings.push({
      id: `R${findings.length + 1}`, severity: "P1", region: rel,
      symptom: `${sizes.size} 种字号（${sorted.join(", ")}）`,
      cause: "没有真正的字阶，层级只能靠感觉，同类文字会逐次漂移",
      fix: "收敛到 ≤7 档并写进 DESIGN.md 字阶表；先并掉半档（10.5/11.5/12.5/13.5）",
      confidence: 1,
    });
  }
  return findings;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("用法: static-check.mjs [--files a.tsx,b.css] [--tokens app/globals.css] [--bg #cbd2db] [--json] [--strict]");
  console.log("      多个目录/文件用逗号分隔（--files app,components），不能写空格分开——会被报错。无网络、无模型。退出码 0=通过 / 1=P0");
  process.exit(0);
}
if (args.unknown?.length) {
  console.error(`[ui-design] 无法识别的参数：${args.unknown.join(" ")}`);
  console.error("[ui-design] 多目标请用逗号：--files app,components（空格分隔会被静默忽略，故直接拒绝）");
  process.exit(2);
}

const tokenFile = findTokenFile(args.tokens);
if (!tokenFile) {
  console.error("[ui-design] 未找到 token 定义文件（试过 app/globals.css 等）。对比度检查已跳过——用 --tokens <path> 指定。");
}
const vars = tokenFile ? extractCssVars(readFileSync(tokenFile, "utf8")) : new Map();
if (tokenFile && vars.size === 0) {
  console.error(`[ui-design] ${tokenFile} 里没抽出 :root/@theme 自定义属性，对比度检查已跳过。`);
}
const files = collectFiles(args.files).filter((f) => {
  // token 定义文件本身不算「违约」（它就该写字面色值）
  return !tokenFile || resolve(f) !== resolve(tokenFile);
});

const findings = [];
if (vars.size > 0) findings.push(...checkContrast(vars, args));
if (files.length > 0) {
  findings.push(...checkTokens(files));
  findings.push(...checkRhythm(files));
}
const order = { P0: 0, P1: 1, P2: 2 };
findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

const summary = {
  ok: findings.filter((f) => f.severity === "P0").length === 0,
  tokens_file: tokenFile ? relative(ROOT, tokenFile).replace(/\\/g, "/") : null,
  text_tokens_checked: vars.size > 0 ? TEXT_TOKENS.filter((t) => resolveColor(t, vars, "light")) : [],
  files_scanned: files.length,
  findings_count: findings.length,
  by_severity: {
    P0: findings.filter((f) => f.severity === "P0").length,
    P1: findings.filter((f) => f.severity === "P1").length,
    P2: findings.filter((f) => f.severity === "P2").length,
  },
  // 明确声明能力边界，避免误以为「过了静态检查=设计没问题」
  cannot_detect: [
    "装饰溢出到操作面（如多余的光晕/渐变层）",
    "被视口裁切的残片、重叠遮挡等只在渲染后显形的问题",
    "整体气质、克制感、是否『像 AI 做的』",
    "真实字体渲染差异与抗锯齿观感",
  ],
  findings,
};
console.log(JSON.stringify(summary, null, args.json ? 2 : 0));
const hasP0 = summary.by_severity.P0 > 0;
process.exit(hasP0 || (args.strict && findings.length > 0) ? 1 : 0);
