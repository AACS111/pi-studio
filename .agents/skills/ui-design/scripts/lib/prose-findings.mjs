/**
 * 散文体 findings 兜底解析 + 截断 JSON 抢救（从 design-review.mjs 抽出，便于独立测试）。
 *
 * 为什么需要：很多推理型多模态模型会无视「只输出 JSON」的指令——
 * 要么改用散文体列 findings，要么在 content 里先写几千字思考、刚开写 JSON 就被
 * max_tokens 削断（实测 kimi-k2.7：思考 + 思考结束标记 + 开了头的 JSON，断尾）。
 * 流水线阶段 6 要靠**结构化条目**才能一次性批量修，不能把整轮评审降级成一堆文本。
 *
 * 散文实测三种变体（均来自真实模型输出）：
 *   A `F1: P1 region: … cause: … fix: …`
 *   B `F1 P0 region: X. symptom: Y. cause: Z. fix: W. confidence 0.95`（编号后无冒号）
 *   C `1. P0: 一句话描述` / `- **P0** — 一句话`
 *
 * 实现刻意不用 new RegExp 拼标签：上一版把字符类写错成匹配字面字母 r，
 * 且分隔符类漏了空白（真实输出里 region 前面是空格），导致 region 全提不到。
 * 这里改成「找标签 → 校验边界 → 值必须紧跟冒号」的纯字符串扫描，可读也可测。
 */

const FINDING_HEAD = /^[ \t>#*]*(?:F\d+[\s:：]*|\d+[.)\]]\s*)?P[0-9]\b/gm;
const FIELD_LABELS = ["region", "symptom", "cause", "fix", "confidence"];
/** 思考结束标记的字面量。拼出来而不成文写，是为了绕开宿主工具层对它的转义 bug。 */
const THINK_CLOSE = "<" + "/think>";

const isWord = (ch) => !!ch && /[A-Za-z0-9_]/.test(ch);

/**
 * 从一条 finding 文本里按标签取值。
 * 命中条件：标签成词（前面不是字母数字，允许 `*`/`_`/空白/行首）+ 跳过 markdown 残留与空白后
 * 紧跟 `:` / `：` / `-`。这样 "the fix is X" 不会被当成 fix:，"prefill:" 也不会误命中 fix。
 */
export function proseFields(chunk) {
  const lower = chunk.toLowerCase();
  const hits = [];
  for (const label of FIELD_LABELS) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(label, from);
      if (i < 0) break;
      from = i + label.length;
      const prev = lower[i - 1] ?? "";
      if (isWord(prev) && !/[*_]/.test(prev)) continue; // prefill 之类不算
      let j = from;
      while (j < chunk.length && /[*_`\])]/.test(chunk[j])) j++;
      while (j < chunk.length && /\s/.test(chunk[j])) j++;
      const sep = chunk[j];
      if (sep !== ":" && sep !== "：" && sep !== "-") continue;
      hits.push({ label, labelStart: i, valueStart: j + 1 });
    }
  }
  hits.sort((a, b) => a.valueStart - b.valueStart);
  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const stop = i + 1 < hits.length ? hits[i + 1].labelStart : chunk.length;
    const value = chunk.slice(hits[i].valueStart, stop)
      .replace(/^[\s-]+/, "").replace(/[\s.，,;]+$/, "").replace(/\s+/g, " ").trim();
    if (value && !out[hits[i].label]) out[hits[i].label] = value;
  }
  return out;
}

/** 对文本做字符串感知的花括号配平扫描，返回每个顶层 { } 对象的 [start, end]。 */
function braceSpans(text) {
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
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start >= 0) { spans.push([start, i]); start = -1; } }
  }
  return spans;
}

/**
 * 截断 JSON 抢救：模型先写思考再开 JSON、被 max_tokens 削断时，从 "findings" 锚点后
 * 逐个提取**配平完整**的条目对象，丢掉断尾的最后一条。拿回 2/5 条也比整轮报废强。
 */
export function salvageTruncatedJson(raw) {
  const thinkEnd = raw.lastIndexOf(THINK_CLOSE);
  const hay = thinkEnd >= 0 ? raw.slice(thinkEnd + THINK_CLOSE.length) : raw;
  const anchor = hay.indexOf('"findings"');
  if (anchor < 0) return null;
  const items = [];
  for (const [s, e] of braceSpans(hay.slice(anchor))) {
    try {
      const obj = JSON.parse(hay.slice(anchor).slice(s, e + 1));
      if (obj && typeof obj === "object"
        && ("fix" in obj || "severity" in obj || "region" in obj || "symptom" in obj)) {
        items.push(obj);
      }
    } catch { /* 断尾/非法条目跳过 */ }
  }
  if (items.length === 0) return null;
  const summary = hay.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  const generic = hay.match(/"looks_like_generic_ai"\s*:\s*(true|false)/)?.[1];
  return {
    summary: `${summary ? summary + " " : ""}（JSON 被输出上限截断，已抢救 ${items.length} 条完整 findings）`,
    findings: items,
    looks_like_generic_ai: generic === "true" ? true : generic === "false" ? false : null,
    score: null,
  };
}

/**
 * 第二轮兜底：markdown 列表式 findings——严重度写在句中而不是行首，如
 *   1. **紫色光晕出现在高频操作区（P0）** —— 底部大面积紫蓝渐变
 * 防御性保留：FINDING_HEAD 要求 P[0-9] 在行首，这类输出会一律 miss。
 * （注：实测 qwen3.8-flash / glm-5.3-flash 其实返回的是**完整 JSON**，
 * 早期「findings 为 0」是我把返回值解构成 findings 所致，不是格式问题。）
 */
function extractListFindings(raw) {
  const findings = [];
  for (const line of raw.split("\n")) {
    if (!/^\s*(?:[-*]|\d+[.)\]])\s+/.test(line)) continue;
    const sev = line.match(/\b(P[0-9])\b/);
    if (!sev) continue;
    const bare = line.replace(/^\s*(?:[-*]|\d+[.)\]])\s+/, "").replace(/[*_`]/g, "").trim();
    if (!bare) continue;
    const f = proseFields(bare);
    const conf = Number(bare.match(/confidence\s*[:：]?\s*([0-9.]+)/i)?.[1]);
    findings.push({
      id: `F${findings.length + 1}`,
      severity: sev[1],
      region: f.region || "",
      symptom: f.symptom || bare.replace(/\s*[（(]\s*P[0-9]\s*[)）]/g, "").replace(/\s{2,}/g, " ").trim(),
      cause: f.cause || "",
      fix: f.fix || "",
      confidence: Number.isFinite(conf) ? conf : null,
    });
    if (findings.length >= 8) break;
  }
  if (findings.length === 0) return null;
  return {
    summary: `（markdown 列表兜底解析，共 ${findings.length} 条）`,
    findings,
    looks_like_generic_ai: /looks_like_generic_ai[\s:\-]*true/i.test(raw) ? true : null,
    score: null,
  };
}

export function extractProseFindings(raw) {
  // 先锚定「Findings:」小标题之后的正式作答区；没有该标题则全文扫。
  const anchor = raw.search(/^[ \t]*(?:##+[ \t]*)?findings[ \t]*:?[ \t]*$/im);
  const haystack = anchor >= 0 ? raw.slice(anchor) : raw;
  const heads = [...haystack.matchAll(FINDING_HEAD)];
  const findings = [];
  for (let i = 0; i < heads.length; i++) {
    const chunk = haystack
      .slice(heads[i].index, i + 1 < heads.length ? heads[i + 1].index : haystack.length)
      .replace(/^[ \t>#*]*/gm, "");
    const f = proseFields(chunk);
    const confidence = Number(chunk.match(/confidence\s*[:：]?\s*([0-9.]+)/i)?.[1]);
    const rec = {
      id: chunk.match(/^\s*(F\d+)\b/)?.[1] || `F${findings.length + 1}`,
      severity: chunk.match(/\b(P[0-9])\b/)?.[1] || "P2",
      region: f.region || "",
      symptom: f.symptom || "",
      cause: f.cause || "",
      fix: f.fix || "",
      confidence: Number.isFinite(confidence) ? confidence : null,
    };
    // 变体 C：只有「严重度 + 一句话」，没有字段名 —— 整行当缺陷描述，不能丢。
    if (!rec.fix && !rec.cause && !rec.symptom) {
      const firstLine = chunk.split("\n").slice(0, 2).join(" ")
        .replace(/^\s*(?:[-*]|\d+[.)\]])?\s*/, "")     // 去列表符号 / 编号
        .replace(/^\[?P[0-9]\]?\s*[:：\-—]?\s*/i, "")  // 去严重度
        .replace(/^[\s>*_`]+|[\s*_`]+$/g, "")
        .trim();
      if (!firstLine) continue;
      rec.symptom = firstLine;
      rec.fix = firstLine;
    }
    findings.push(rec);
  }
  if (findings.length === 0) return extractListFindings(raw);
  const summary = raw.match(/(?:^|\n)\s*(?:Key issues|Summary|总体|结论)[\s\S]{0,300}/i)?.[0]
    ?.replace(/\s+/g, " ").trim();
  return {
    summary: summary || `（散文体兜底解析，共 ${findings.length} 条）`,
    findings,
    looks_like_generic_ai:
      /looks_like_generic_ai[\s:\-]*true|generic ai[\s:\-]*true|strong indicator/i.test(raw) ? true : null,
    score: null,
  };
}
