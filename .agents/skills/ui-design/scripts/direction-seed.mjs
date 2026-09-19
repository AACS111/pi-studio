#!/usr/bin/env node
/**
 * 外部方向种子：打破模型「永远交同一张牌」的惯性。
 *
 * 为什么必须有它：SKILL.md 里写「必须出 6 个互斥交互范式方向」只是**要求**，拦不住
 * 模型的 argmax 惯性——同一模型对同类需求会稳定收敛到它最常见的构图（业界实测口径：
 * 30/35 次交出完全相同的概念，跨 16 种提问措辞都不变）。用户侧体验就是
 * 「生成 8 个方案，看上去区别不大」。**自然语言提不了这个险，随机性必须从外部注入。**
 *
 * 做法（不猜模型想要什么，只规定它必须回避什么、必须证明什么）：
 *   1. 点名该品类那个 everyone-tuned-out 的默认构图，本轮强制回避；
 *   2. 按「日期 + 项目路径（+ --reroll）」取模，指派 2 个非直觉范式为必答题；
 *   3. 从 reference/paradigm-bank.json 给出候选池——主轴是「信息如何组织与推进」，
 *      不是配色；换卡等于换交互。
 *   4. 同一项目同一天结果稳定（避免反复横跳），--reroll 手动换一批。
 *
 * 用法：node direction-seed.mjs [--count 6] [--reroll 1] [--domain tool|app|landing|docs]
 *      node direction-seed.mjs --list     # 只列卡池，不掷骰
 * 输出 JSON，作为 SKILL.md 阶段 1 的输入约束。
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const o = { count: 6, reroll: 0, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--count") o.count = Number(argv[++i]) || 6;
    else if (a === "--reroll") o.reroll = Number(argv[++i]) || 1;
    else if (a === "--domain") o.domain = argv[++i];
    else if (a === "--list") o.list = true;
  }
  return o;
}

const load = () => JSON.parse(readFileSync(join(SKILL_DIR, "reference", "paradigm-bank.json"), "utf8"));

/** 稳定散列：同一 (seedKey) 永远得到同一序列，保证同一天同项目可复现。 */
function hashSeq(seedKey) {
  const out = [];
  let counter = 0;
  while (out.length < 64) {
    const h = createHash("sha256").update(`${seedKey}#${counter}`).digest();
    for (const b of h) out.push(b);
    counter++;
  }
  return out;
}

/** 从池中按哈希取 N 个不重复项（Fisher-Yates 的哈希变体，不依赖 Math.random）。 */
function pick(pool, n, seq, offset = 0) {
  const idx = pool.map((_, i) => i);
  for (let i = 0; i < idx.length; i++) {
    const j = offset + i;
    const k = i + (seq[j % seq.length] % (idx.length - i));
    [idx[i], idx[k]] = [idx[k], idx[i]];
  }
  return idx.slice(0, Math.min(n, idx.length)).map((i) => pool[i]);
}

function inferDomain(args, defaults) {
  if (args.domain) {
    if (!defaults[args.domain]) {
      console.error(`[ui-design] --domain 只支持 ${Object.keys(defaults).join(" / ")}，收到 "${args.domain}"`);
      process.exit(2);
    }
    return args.domain;
  }
  // 无 PRODUCT.md 时按 cwd 关键词粗判，命中不了就归到 tool（最保守）
  const cwd = projectRoot().toLowerCase();
  for (const [key, d] of Object.entries(defaults)) {
    if ((d.match || []).some((w) => cwd.includes(w))) return key;
  }
  return "tool";
}

/** 向上找项目根：有 .git 或 package.json 就算，最多 8 层。
 * 不能用 process.cwd() 直接当种子——技能脚本被从任意子目录调用时，
 * 同一项目的掷骰结果会不同，「同项目同一天稳定」就破功了。 */
function projectRoot() {
  let dir = resolve(process.cwd());
  for (let depth = 0; depth < 8; depth++) {
    try {
      if (existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json"))) return dir;
    } catch { /* ignore */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd());
}

function findProductMd() {
  let dir = projectRoot();
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, "PRODUCT.md"))) return join(dir, "PRODUCT.md");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const bank = load();
const ROOT = projectRoot();

if (args.list) {
  console.log(JSON.stringify(bank.paradigms.map(({ id, name, axis }) => ({ id, name, axis })), null, 2));
  process.exit(0);
}

// 卡池太小时「6 个互斥方向」无法由种子支撑，必须明说，不能默默交少数几个。
if (args.count > bank.paradigms.length) {
  console.error(`[ui-design] --count ${args.count} 超过卡池容量 ${bank.paradigms.length}；`
    + "要么降低 --count，要么往 reference/paradigm-bank.json 加卡（单卡≈140 token 会进每次掷骰输出，别一次加太多）。");
  process.exit(2);
}
const COUNT = Math.max(3, args.count);

const domain = inferDomain(args, bank.defaults);
const rut = bank.defaults[domain];
const day = new Date().toISOString().slice(0, 10);
const seq = hashSeq(`${day}|${ROOT}|${args.reroll}`);

// 指派 2 个必答题；再给 (count-2) 个备选，凑成阶段 1 要交的 N 个方向
const chosen = pick(bank.paradigms, Math.min(COUNT, bank.paradigms.length), seq, 0);
const assigned = chosen.slice(0, 2);
const pool = chosen.slice(2);

console.log(JSON.stringify({
  seed: { date: day, domain, reroll: args.reroll, project_root: ROOT, product_md: findProductMd() },
  must_avoid: {
    label: rut.label,
    composition: rut.rut,
    reason: rut.why,
    rule: "本轮**禁止**把它当作任何一个方向的骨架（可局部借用其某个成熟部件，但要说明为什么）。",
  },
  assigned: assigned.map((p, i) => ({
    slot: i + 1,
    id: p.id,
    name: p.name,
    axis: p.axis,
    advance: p.advance,
    density: p.density,
    layering: p.layering,
    fits: p.fits,
    known_failure: p.fails,
    requirement: "必须为该范式画一张**结构上与其他方向明显不同**的 ASCII 线框，"
      + "并说明它服务什么场景、代价是什么、你如何预先防住 known_failure。",
  })),
  optional_pool: pool.map((p) => ({ id: p.id, name: p.name, axis: p.axis, fits: p.fits })),
  rules: [
    `本阶段共需 ${COUNT} 个互斥方向：${assigned.length} 个由种子指派（必答，不可替换），`
      + `其余可从 optional_pool 自由挑选或自行提出。`,
    "互斥的判据是「组织主轴 + 推进方式」，不是配色/字体/圆角——只换皮肤的方案视为无效探索。",
    "种子指派的方向若确实不适合本产品，**不许直接丢弃**：要么给出更优替代并说明理由，"
      + "要么明确写出它在哪个真实场景下会赢。",
    "先想内容后想界面：每个方向都要用 PRODUCT.md 与代码里的真实对象、真实动作来填充，不放 lorem。",
    "本阶段只交静态设计，不做交互、不套浏览器/设备外框。",
  ],
  next: `把它交进 SKILL.md 阶段 1；${COUNT} 个方向完整呈现后停住，等用户选 1 个再进阶段 3。`,
}, null, 2));
