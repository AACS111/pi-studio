#!/usr/bin/env node
/**
 * ui-design 技能的胶水脚本：截图 → 独立视觉模型评审 → 结构化 findings。
 *
 * 为什么需要它：设计闭环的两个零件（右侧浏览器截图、多模态视觉模型）在 Pi Studio 里
 * 早就存在，但没有任何东西把它们串起来，于是「评审」退化成用户人肉看截图说「不好看」、
 * 模型再猜一次。本脚本把闭环固化成一条命令。
 *
 * 子命令：
 *   --context                    探测项目设计真相（DESIGN.md/PRODUCT.md）与可选增强技能
 *   --shot    --out f.png        Electron 右侧浏览器截图（GET /api/browser/control/screenshot）
 *   --review  --in f.png [...]   截图 + rubric + DESIGN.md 节选 → POST /api/vision/describe
 *   --selftest                   不联网，校验参数解析与技能资产是否齐全
 *
 * 端口发现：agent 的 bash 继承本进程的 PI_WEB_PORT（lib/bundled-skills.ts 保证非 "0"）；
 * 显式 --api-base 优先；否则按 [PI_WEB_PORT, 10141(dev), 10142(packaged)] 逐个探活
 * （GET /api/browser/control/health —— 返回 502 也算服务活着）。
 *
 * 评审独立性：--model provider/modelId 可强制换一个模型当评审；默认走「附属模型」里配置的
 * 视觉模型（app/api/vision/describe 的解析顺序），它天然不同于生成方在用主模型——
 * 这是本技能最重要的工程约束，别退回自评。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { extractProseFindings, salvageTruncatedJson } from "./lib/prose-findings.mjs";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FALLBACK_PORTS = ["10141", "10142"];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 与 lib/image-attachments.ts 对齐
/**
 * 默认 240s：实测真实产品界面截图（非小 mock）+ 推理型多模态评审模型会超过 120s，
 * 而 /api/vision/describe 内部还会重试一次，因此留出余量；可用 env 覆盖。
 */
const PROXY_TIMEOUT_MS = Number(process.env.PI_UI_DESIGN_TIMEOUT_MS) || 240_000;

function parseArgs(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--context": opts.mode = "context"; break;
      case "--shot": opts.mode = "shot"; break;
      case "--review": opts.mode = "review"; break;
      case "--selftest": opts.mode = "selftest"; break;
      case "--out": opts.out = next(); break;
      case "--in": case "--file": case "--image": opts.in = next(); break;
      case "--source": opts.source = next(); break;
      case "--model": opts.model = next(); break;
      case "--rubric": opts.rubric = next(); break;
      case "--design": opts.design = next(); break;
      case "--region": opts.region = next(); break;
      case "--api-base": opts.apiBase = next(); break;
      case "--full-page": opts.fullPage = true; break;
      case "--wait": opts.waitMs = Number(next()) || 0; break;
      case "--no-retry": opts.noRetry = true; break;
      case "--no-raise-budget": opts.noRaiseBudget = true; break;
      case "--json": opts.json = true; break;
      case "--max-chars": opts.maxChars = Number(next()) || 2000; break;
      default:
        if (!a.startsWith("-") && !opts.in) opts.in = a;
        break;
    }
  }
  return opts;
}

function parseModelFlag(value) {
  if (!value) return undefined;
  const i = value.indexOf("/");
  if (i <= 0) throw new Error(`--model 需要 provider/modelId 格式，收到 "${value}"`);
  return { provider: value.slice(0, i), modelId: value.slice(i + 1) };
}

/** 探活并返回可用的 API base（打包版端口可能被 PI_WEB_PORT 改过）。 */
async function resolveApiBase(explicit) {
  if (explicit) return explicit.replace(/\/$/, "");
  const candidates = [];
  if (process.env.PI_WEB_PORT) candidates.push(process.env.PI_WEB_PORT);
  candidates.push(...FALLBACK_PORTS);
  for (const port of [...new Set(candidates.filter(Boolean))]) {
    const base = `http://127.0.0.1:${port}`;
    try {
      // 502 = 无浏览器桥但服务在；只要拿到 HTTP 响应就认为可用
      const res = await fetch(`${base}/api/browser/control/health`, { signal: AbortSignal.timeout(2500) });
      if (res.status < 600) return base;
    } catch { /* try next port */ }
  }
  console.error(`[ui-design] 未探到 Pi Studio 服务（已试 127.0.0.1:${candidates.join(" / ")}），回退默认端口。`);
  return `http://127.0.0.1:${FALLBACK_PORTS[0]}`;
}

async function postJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${data?.error || res.statusText}`);
  return data;
}

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${data?.error || res.statusText}`);
  return data;
}

/** DESIGN.md 节选：优先取 --region 命中的小节附近，否则取开头 maxChars。 */
function designExcerpt(designPath, region, maxChars) {
  if (!existsSync(designPath)) return null;
  const text = readFileSync(designPath, "utf8");
  if (!region) return text.slice(0, maxChars);
  const idx = text.toLowerCase().indexOf(String(region).toLowerCase());
  if (idx < 0) return text.slice(0, maxChars);
  return text.slice(Math.max(0, idx - 200), idx + maxChars);
}

/** 向上找项目根的 DESIGN.md（最多 8 层）。 */
function findDesignMd(startDir = process.cwd()) {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 8; depth++) {
    for (const name of ["DESIGN.md", "design.md"]) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 可选增强：用户自行安装的 impeccable（不随包分发，见 docs/agents/design-system.md §3）。 */
function locateImpeccable() {
  const roots = [
    process.env.PI_STUDIO_SKILLS_DIR,
    process.env.PI_STUDIO_USER_SKILLS_DIR,
    join(SKILL_DIR, ".."),
    join(homedir(), ".pi", "agent", "skills"),
    join(homedir(), ".agents", "skills"),
  ].filter(Boolean);
  for (const r of roots) {
    const p = join(r, "impeccable", "scripts", "context.mjs");
    if (existsSync(p)) return { dir: join(r, "impeccable"), context: p };
  }
  return null;
}

/** 评审者角色与输出约束。vision 接口只有 text（无独立 system 通道），所以必须拼进正文头部。 */
const REVIEW_SYSTEM = [
  "你是资深视觉设计评审（Design Critic）。你只看这张截图，看不到代码、看不到设计意图，也不参与过实现。",
  "你的任务不是夸，而是找出「让这张图显得廉价/平庸/像 AI 生成」的具体缺陷，并给出可直接执行的修法。",
  "严格禁止泛泛而谈：不要说「加大对比」「更现代」「优化间距」；必须指名区域、指出违反了哪条 token/规则、给出具体动作。",
  "只输出一个 JSON 对象，不要 markdown 代码块、不要解释文字。schema：",
  '{"summary":"一句话总体判断（含最大问题）","findings":[{"id":"F1","severity":"P0|P1|P2","region":"屏幕上的具体区域","symptom":"你看到什么","cause":"为什么它造成这个观感","fix":"改什么（尽量给 token/数值）","confidence":0.0}],"looks_like_generic_ai":true,"score":{"hierarchy":0,"spacing_rhythm":0,"type":0,"color":0,"restraint":0}}',
  "P0=破坏可读性或层级崩塌；P1=明显廉价感/套路感；P2=细节打磨。最多 8 条，按严重度排序。",
].join("\n");

/**
 * 从模型输出里抓出评审 JSON。
 * 为什么用括号配平而不是 /\{[\s\S]*\}/：推理型多模态模型（kimi 等）会把大段思考混进
 * content，贪婪匹配会跨过思考里的花括号，非贪婪又会截断嵌套对象。
 * 取「最后一个含 findings/summary 的配平对象」= 思考之后的正式作答。
 */
/**
 * 从模型输出里抓出完整评审 JSON。
 * 为什么用括号配平而不是 /\{[\s\S]*\}/：推理型多模态模型（kimi 等）会把思考混进 content，
 * 贪婪匹配会跨过思考里的花括号，非贪婪又会截断嵌套对象。
 * 取「最后一个含 findings 数组的配平对象」 = 思考后的正式作答。
 * 判定要求 findings 为**非空数组**：只要 summary 不算成功（会被当成 json 命中而丢弃后续兜底）。
 */
function extractReviewJson(text) {
  const candidates = topLevelBraceSpans(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const slice = text.slice(candidates[i][0], candidates[i][1] + 1);
    if (!/"findings"/.test(slice)) continue;
    try {
      const parsed = JSON.parse(slice);
      if (!parsed || typeof parsed !== "object") continue;
      const list = Array.isArray(parsed.findings) ? parsed.findings : null;
      if (!list || list.length === 0) continue;
      return parsed;
    } catch { /* keep scanning backwards */ }
  }
  return null;
}

/**
 * 一次正向扫描（字符串感知）列出所有「花括号配平闭合到 0」的区间。
 * O(n)：反向逐个 `}` 定位 `{` 会对每处重扫全文，推理型输出几 KB 就卡。
 */
function topLevelBraceSpans(text) {
  const spans = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth === 0) continue; // 多余右括号，忽略
      depth--;
      if (depth === 0 && start >= 0) spans.push([start, i]);
    }
  }
  return spans;
}

async function modeContext() {
  const design = findDesignMd();
  const product = existsSync(join(process.cwd(), "PRODUCT.md")) ? join(process.cwd(), "PRODUCT.md") : null;
  const imp = locateImpeccable();
  const out = {
    cwd: process.cwd(),
    product_md: product,
    design_md: design,
    impeccable: imp ? `available (${imp.dir})` : "not installed (skill works without it)",
    rubric_default: join(SKILL_DIR, "reference", "review-rubric.md"),
    next: [],
  };
  if (!product) out.next.push("缺少 PRODUCT.md：按 templates/PRODUCT.md.template 向用户问 4 个问题后写入项目根（外部方向种子依赖它）");
  if (!design) out.next.push("缺少 DESIGN.md：就地抽取现有 CSS 变量/Tailwind theme/组件，按 templates/DESIGN.md.template 写入项目根，再进入方向探索");
  if (out.next.length === 0) out.next.push("设计真相齐备：可进入阶段 1 方向探索");
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

async function modeShot(opts, base) {
  const out = opts.out || join(process.cwd(), `.ui-design-shot-${Date.now()}.png`);
  const q = new URLSearchParams({ json: "1" });
  if (opts.fullPage) q.set("full_page", "true");
  if (opts.region) q.set("selector", opts.region);
  if (opts.waitMs) q.set("wait_ms", String(opts.waitMs));
  let data;
  try {
    data = await getJson(base, `/api/browser/control/screenshot?${q.toString()}`);
  } catch (err) {
    console.error(`[ui-design] 右侧浏览器截图失败：${err.message}`);
    console.error("[ui-design] 需要 Electron 桌面模式且有活动标签页（pnpm run dev:electron 或打包应用）。");
    console.error("[ui-design] 兜底：headless 自行截图，或用 --in <png> 直接评审文件。");
    return 2;
  }
  if (!data.png_base64) {
    console.error("[ui-design] 桥返回里没有 png_base64 字段");
    return 2;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(data.png_base64, "base64"));
  console.log(JSON.stringify({ ok: true, file: out, bytes: Math.round(data.png_base64.length * 0.75) }, null, 2));
  return 0;
}

/**
 * 请求评审 + 解析 + 降级重试。
 *
 * 为什么要降级：视觉接口默认 max_tokens=2048（为「描述图片」短输出设计），
 * 推理型多模态模型会把思考写进 content → findings 被削断；但把预算提到 8192 后，
 * provider 网关自己在 ~90s 处 504（实测 onmicro/kimi-k2.7-code 连续两次）。
 * 两者互斥，所以策略是：先按高预算试，一旦失败就回到默认预算再试——
 * 被截断的输出仍然可用（散文兜底解析器实测能从断尾文本里提出 6–8 条 findings），
 * 比整轮评审报废好得多。照 lib/team/llm-judge.ts 的「安全降级」思路。
 */
async function requestFindings(base, body, opts) {
  const attempts = opts.noRetry ? 1 : 2;
  let last = null;
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const payload = i === 0 ? body : { ...body, maxTokens: undefined, timeoutMs: undefined };
    let res;
    try {
      res = await postJson(base, "/api/vision/describe", payload);
    } catch (err) {
      lastError = err;
      console.error(`[ui-design] 第 ${i + 1} 次评审请求失败：${String(err.message).split("\n")[0].slice(0, 150)}`);
      if (i + 1 < attempts) console.error("[ui-design] 回落到默认输出预算重试…");
      continue;
    }
    lastError = null;
    const raw = String(res.description || "");
    const json = extractReviewJson(raw);
    // 完整 JSON > 截断 JSON 里的完整条目（实测：降回默认预算后模型先写思考再开 JSON，
    // 刚写完一两条就被削断）> 散文体。
    const salvaged = json ? null : salvageTruncatedJson(raw);
    const parsed = json || salvaged || extractProseFindings(raw);
    last = {
      res,
      raw,
      parsed,
      source: json ? "json" : salvaged ? "json-salvaged" : parsed ? "prose-fallback" : null,
      degraded: i > 0,
    };
    if (parsed) return last;
    if (i + 1 < attempts) console.error(`[ui-design] 第 ${i + 1} 次输出不可解析（${raw.length} 字，疑被截断），重试中…`);
  }
  if (lastError) throw lastError;
  return last;
}

async function modeReview(opts, base) {
  if (!opts.in) { console.error("评审需要 --in <png>（或先跑 --shot --out x.png）"); return 2; }
  if (!existsSync(opts.in)) { console.error(`找不到图片：${opts.in}`); return 2; }
  const buf = readFileSync(opts.in);
  if (buf.length > MAX_IMAGE_BYTES) {
    console.error(`图片 ${(buf.length / 1048576).toFixed(1)}MB 超过视觉模型 ${MAX_IMAGE_BYTES / 1048576}MB 上限，请缩小或只截目标区域`);
    return 2;
  }
  const rubricPath = opts.rubric || join(SKILL_DIR, "reference", "review-rubric.md");
  if (!existsSync(rubricPath)) { console.error(`找不到评审 rubric：${rubricPath}`); return 2; }
  const designPath = opts.design || findDesignMd();
  const excerpt = designPath ? designExcerpt(designPath, opts.region, opts.maxChars || 2000) : null;

  const prompt = [
    REVIEW_SYSTEM,
    "",
    "## 评审 rubric（唯一评判标准）",
    readFileSync(rubricPath, "utf8").trim(),
    "",
    excerpt ? "## 本项目 DESIGN.md（token 契约，违反它 = 缺陷）" : "## 本项目 DESIGN.md\n（缺失——按通用反 AI 味标准评审，并在 summary 里提醒补 DESIGN.md）",
    excerpt || "",
    "",
    `## 被评审目标${opts.region ? `：区域「${opts.region}」` : "：整屏截图"}`,
    "现在只依据上面这张图与 rubric 输出结构化 findings。",
    "",
    // 钳住思考 + 提高预算双保险：视觉接口默认 max_tokens=2048（为「描述图片」短输出设计），
    // 推理型多模态模型（kimi 等）会把思考写进 content → findings 被削断
    // （实测同一张图两次输出 8991 / 8997 字均断尾，findings 一条也没写出）。
    // 一是要求只给结果，二是请求里带 maxTokens（见 app/api/vision/describe/route.ts 的可选项）。
    "输出约束（硬规则，逐条守）：",
    "1. 第一个字符必须是 `{`；不要写分析过程、不要写「Let's analyze」、不要先列提纲。思考在内部完成。",
    "2. 输出**紧凑单行 JSON**（不换行不缩进），全文 ≤ 1200 字。",
    "3. findings **最多 4 条**，只给最重要的；每条 symptom / cause / fix 各 ≤ 40 字。",
    "4. 宁可少写也不能写不完：被截断的 JSON 等于零价值。",
  ].join("\n").replace(/\n{3,}/g, "\n\n");

  const body = {
    text: prompt,
    images: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }],
    // 评审需要结构化长输出，拿掉默认 2048 的截断；--no-raise-budget 可回退默认。
    // timeoutMs 同步拉长（否则服务端默认 90s 会 502），但必须小于本进程的 PROXY_TIMEOUT_MS。
    maxTokens: opts.noRaiseBudget ? undefined : 8192,
    timeoutMs: opts.noRaiseBudget ? undefined : 200_000,
  };
  const model = parseModelFlag(opts.model);
  if (model) body.model = model;

  let attempt;
  try {
    attempt = await requestFindings(base, body, opts);
  } catch (err) {
    const timeout = err?.name === "AbortError" || /abort|timeout/i.test(String(err?.message));
    if (timeout) {
      console.error(`[ui-design] 视觉评审超时（> ${Math.round(PROXY_TIMEOUT_MS / 1000)}s）。模型确实可能慢，`);
      console.error("[ui-design] 先试：缩小截图（--region / 只截目标组件）、换更快的视觉模型、或 PI_UI_DESIGN_TIMEOUT_MS=600000 放宽上限。");
    } else {
      console.error(`[ui-design] 视觉评审失败：${err.message}`);
      console.error("[ui-design] 常见原因：未配置支持图片的视觉模型（左下角模型菜单 → 附属模型 → 视觉模型）。");
    }
    return 2;
  }
  const { res, raw, parsed, source, degraded } = attempt;
  console.log(JSON.stringify({
    ok: true,
    critic_model: `${res.providerId}/${res.modelId}`,
    budget: degraded ? "provider 默认（已降级）" : "8192 tokens / 200s",
    image: basename(opts.in),
    design_md: designPath || null,
    rubric: basename(rubricPath),
    prompt_chars: prompt.length,
    findings_source: source,
    findings_count: parsed?.findings?.length ?? 0,
    parsed,
    raw: parsed ? undefined : raw,
    note: parsed ? undefined
      : "评审模型既没返回 JSON、也没命中 F<n>/编号 + P0|region:|cause:|fix: 散文格式（原文已保留）。用 --model 换一个指令遵循更好的多模态模型，或缩小截图重试。",
  }, null, 2));
  return 0;
}

function modeSelftest(opts) {
  const rubric = join(SKILL_DIR, "reference", "review-rubric.md");
  const checks = {
    skill_dir: SKILL_DIR,
    skill_md_exists: existsSync(join(SKILL_DIR, "SKILL.md")),
    rubric_exists: existsSync(rubric),
    design_template_exists: existsSync(join(SKILL_DIR, "templates", "DESIGN.md.template")),
    product_template_exists: existsSync(join(SKILL_DIR, "templates", "PRODUCT.md.template")),
    design_md_found: findDesignMd(),
    impeccable: locateImpeccable() ? "available" : "absent",
    env_skills_dir: process.env.PI_STUDIO_SKILLS_DIR || null,
    api_base_would_use: opts.apiBase || process.env.PI_WEB_PORT || "probe 10141 then 10142",
    review_system_len: REVIEW_SYSTEM.length,
    json_extractor_ok: extractReviewJson('thinking {"junk":true} here {"summary":"s","findings":[{"id":"F1","severity":"P1","region":"r","fix":"f"}]}') !== null
      // 收紧后的反向断言：只有 summary / findings 为空 都不算命中（否则会吞掉后续兜底）
      && extractReviewJson('{"summary":"s","findings":[]}') === null,
    salvage_extractor_ok: (() => {
      const closed = "<" + "/think>";
      const r = salvageTruncatedJson(closed + '{"summary":"s","findings":[{"id":"F1","severity":"P0","region":"r","fix":"f"},{"id":"F2","se');
      return r?.findings?.length === 1 && r.findings[0].fix === "f";
    })(),
    prose_extractor_ok: (() => {
      const r = extractProseFindings(
        'intro prose\nF1: P1 region: 卡片栅格 cause: 五张卡同权重 fix: 保留一个主卡\nF2: P0 region: 按钮 cause: 非 token 紫色 fix: 改回 --accent',
      );
      const list = extractProseFindings(
        '1. **紫色光晕出现在高频操作区（P0）** —— 底部大面积紫蓝渐变。\n2. **无第一焦点（P1）** —— 所有区块同权重。',
      );
      return r?.findings?.length === 2 && list?.findings?.length === 2 && list.findings[0].severity === "P0";
    })(),
  };
  console.log(JSON.stringify(checks, null, 2));
  const fatal = !checks.skill_md_exists || !checks.rubric_exists
    || !checks.design_template_exists || !checks.product_template_exists
    || !checks.json_extractor_ok || !checks.prose_extractor_ok || !checks.salvage_extractor_ok;
  console.log(fatal ? "SELFTEST: FAIL (missing skill assets)" : "SELFTEST: PASS");
  return fatal ? 1 : 0;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.mode) {
  console.log("用法: design-review.mjs --context | --shot --out x.png [--full-page] [--region sel] | --review --in x.png [--model provider/id] [--region 区域] [--rubric path] [--design path] [--max-chars n] | --selftest [--api-base url]");
  process.exit(2);
}
try {
  const base = (opts.mode === "context" || opts.mode === "selftest")
    ? (opts.apiBase || "unused")
    : await resolveApiBase(opts.apiBase);
  const code = opts.mode === "context" ? await modeContext()
    : opts.mode === "shot" ? await modeShot(opts, base)
    : opts.mode === "review" ? await modeReview(opts, base)
    : modeSelftest(opts);
  process.exit(code);
} catch (err) {
  console.error(`[ui-design] 执行异常：${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
