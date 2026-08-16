/**
 * memory-zh — 中文跨会话永久记忆扩展（按项目隔离）
 *
 * 参考 pi-memory（https://pi.dev/packages/pi-memory）的功能设计，做中文优先 + 按项目隔离：
 *   - 长期记忆 MEMORY.md（决策/偏好/事实）
 *   - 每日日志 daily/YYYY-MM-DD.md（本地日期，按天追加）
 *   - 待办清单 SCRATCHPAD.md（add / done / undo / clear_done / list）
 *   - 删除恢复 recovery/（forget 生成恢复码，restore 还原）
 *   - 每轮对话前自动注入（限制条数与字符，控制 token 成本）
 *   - 中文友好检索：多关键词全部命中同一行、支持 #标签 和 [[链接]] 精确匹配
 *   - 零外部依赖（不需要 qmd / 向量模型，无模型下载问题）
 *
 * 存储结构（每个项目独立目录，互不串味）：
 *   <PI_MEMORY_DIR 或 ~/.pi/agent/memory>/<项目名>-<短hash>/
 *     MEMORY.md
 *     daily/YYYY-MM-DD.md
 *     SCRATCHPAD.md
 *     recovery/<恢复码>.md
 *
 * 安装：
 *   1. 复制到 ~/.pi/agent/extensions/memory-zh.ts（全局，所有项目生效，推荐）
 *   2. 或项目 .pi/extensions/memory-zh.ts（仅该项目，需先信任项目）
 *
 * 环境变量（可选）：
 *   PI_MEMORY_DIR           记忆根目录（默认 ~/.pi/agent/memory）
 *   PI_MEMORY_MAX_CHARS     每轮注入字符上限（默认 6000，0=不限）
 *   PI_MEMORY_MAX_ENTRIES   每轮注入长期记忆条数上限（默认 40）
 *   PI_MEMORY_MAX_SCRATCH   注入开放待办条数上限（默认 10）
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_CHARS = Number(process.env.PI_MEMORY_MAX_CHARS ?? 6000);
const MAX_ENTRIES = Number(process.env.PI_MEMORY_MAX_ENTRIES ?? 40);
const MAX_SCRATCH = Number(process.env.PI_MEMORY_MAX_SCRATCH ?? 10);

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

function memoryRoot(): string {
  return process.env.PI_MEMORY_DIR || join(homedir(), ".pi", "agent", "memory");
}

/** 由 cwd 生成稳定且可读的项目标识：basename-短哈希（唯一、可读） */
function projectSlug(cwd: string): string {
  const norm = cwd.replace(/\\/g, "/").replace(/[/:]+$/, "");
  const base = norm.split("/").filter(Boolean).pop() || "root";
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

function projectDir(cwd: string): string {
  const dir = join(memoryRoot(), projectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function longTermFile(cwd: string): string {
  return join(projectDir(cwd), "MEMORY.md");
}

function dailyDir(cwd: string): string {
  const dir = join(projectDir(cwd), "daily");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dailyFile(cwd: string, date: string): string {
  return join(dailyDir(cwd), `${date}.md`);
}

function scratchFile(cwd: string): string {
  return join(projectDir(cwd), "SCRATCHPAD.md");
}

function recoveryDir(cwd: string): string {
  const dir = join(projectDir(cwd), "recovery");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 本地日期（不能用 toISOString，那是 UTC，晚上会落到明天） */
function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function writeLines(file: string, title: string, lines: string[]): void {
  writeFileSync(file, title + (lines.length ? "\n" + lines.join("\n") : "") + "\n", "utf8");
}

function appendLine(file: string, title: string, line: string): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8").trimEnd() : title;
  writeFileSync(file, existing + "\n" + line + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// 长期记忆
// ---------------------------------------------------------------------------

function loadLongTerm(cwd: string): string[] {
  return readLines(longTermFile(cwd));
}

function saveLongTerm(cwd: string, content: string, mode: "append" | "overwrite"): string {
  const file = longTermFile(cwd);
  const clean = content.replace(/\s+/g, " ").trim();
  const stamp = `- [${todayStr()}] ${clean}`;
  if (mode === "overwrite") {
    writeLines(file, "# 项目长期记忆", [stamp]);
  } else {
    appendLine(file, "# 项目长期记忆", stamp);
  }
  return stamp;
}

/** 按行号(0-based)或关键词删除，返回被删条目 */
function removeFrom(lines: string[], line?: number, query?: string): { kept: string[]; removed: string[] } {
  const q = (query ?? "").toLowerCase();
  const removed: string[] = [];
  const kept = lines.filter((l, i) => {
    const match = line !== undefined ? i === line : q.length > 0 && l.toLowerCase().includes(q);
    if (match) removed.push(l);
    return !match;
  });
  return { kept, removed };
}

// ---------------------------------------------------------------------------
// 每日日志
// ---------------------------------------------------------------------------

function loadDaily(cwd: string, date: string): string[] {
  return readLines(dailyFile(cwd, date));
}

function appendDaily(cwd: string, content: string): string {
  const stamp = `- ${new Date().toISOString().slice(11, 19)} ${content.replace(/\s+/g, " ").trim()}`;
  appendLine(dailyFile(cwd, todayStr()), `# 日志 ${todayStr()}`, stamp);
  return stamp;
}

function allDailyFiles(cwd: string): string[] {
  if (!existsSync(dailyDir(cwd))) return [];
  return readdirSync(dailyDir(cwd))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
}

// ---------------------------------------------------------------------------
// 待办清单
// ---------------------------------------------------------------------------

interface ScratchItem {
  text: string;
  done: boolean;
}

function loadScratch(cwd: string): ScratchItem[] {
  return readLines(scratchFile(cwd)).map((l) => {
    const done = /^-\s*\[x\]\s*/i.test(l);
    return { text: l.replace(/^-\s*\[[ x]\]\s*/i, "").trim(), done };
  });
}

function saveScratch(cwd: string, items: ScratchItem[]): void {
  writeLines(
    scratchFile(cwd),
    "# 待办清单",
    items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`),
  );
}

// ---------------------------------------------------------------------------
// 删除恢复
// ---------------------------------------------------------------------------

function writeRecovery(cwd: string, target: string, removed: string[]): string {
  if (!removed.length) return "";
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const header = [`target: ${target}`, `time: ${new Date().toISOString()}`, "", ...removed].join("\n");
  writeFileSync(join(recoveryDir(cwd), `${id}.md`), header + "\n", "utf8");
  return id;
}

function restoreRecovery(cwd: string, id: string): string {
  const safe = id.replace(/[^a-z0-9-]/gi, "");
  const file = join(recoveryDir(cwd), `${safe}.md`);
  if (!existsSync(file)) return `未找到恢复记录：${id}`;
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  const target = (lines.find((l) => l.startsWith("target:")) ?? "target: long_term").split(":")[1].trim();
  const removed = lines.filter((l) => l.startsWith("- ["));
  if (!removed.length) return "恢复记录中没有可恢复的条目。";
  if (target === "daily") {
    for (const l of removed) appendLine(dailyFile(cwd, todayStr()), `# 日志 ${todayStr()}`, l);
  } else if (target === "scratchpad") {
    const items = loadScratch(cwd);
    for (const l of removed) items.push({ text: l.replace(/^-\s*\[[ x]\]\s*/i, "").trim(), done: false });
    saveScratch(cwd, items);
  } else {
    appendLine(longTermFile(cwd), "# 项目长期记忆", removed[0]);
  }
  return `已恢复 ${removed.length} 条到 ${target}：\n${removed.join("\n")}`;
}

// ---------------------------------------------------------------------------
// 中文友好检索
// ---------------------------------------------------------------------------

/** 按空格/逗号/顿号/分号分词；#标签 与 [[链接]] 去掉修饰符 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，、;；]+/)
    .filter(Boolean)
    .map((t) => t.replace(/^#+/, "").replace(/^\[\[|\]\]$/g, ""));
}

function searchLines(lines: string[], query: string): Array<{ line: number; text: string }> {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const hits: Array<{ line: number; text: string }> = [];
  lines.forEach((l, i) => {
    const ll = l.toLowerCase();
    if (terms.every((t) => ll.includes(t))) hits.push({ line: i, text: l });
  });
  return hits;
}

// ---------------------------------------------------------------------------
// 注入
// ---------------------------------------------------------------------------

function buildInjection(cwd: string): string | null {
  const longTerm = loadLongTerm(cwd);
  const dailyToday = loadDaily(cwd, todayStr());
  const scratchOpen = loadScratch(cwd).filter((i) => !i.done);
  const total = longTerm.length + dailyToday.length + scratchOpen.length;
  if (!total) return null;

  const parts: string[] = [];
  if (longTerm.length) {
    parts.push("【长期记忆】", longTerm.slice(-MAX_ENTRIES).join("\n"));
  }
  if (dailyToday.length) {
    parts.push(`【今日日志 ${todayStr()}】`, dailyToday.slice(-15).join("\n"));
  }
  if (scratchOpen.length) {
    parts.push("【开放待办】", scratchOpen.slice(0, MAX_SCRATCH).map((i) => `- [ ] ${i.text}`).join("\n"));
  }

  let body = parts.join("\n");
  if (MAX_CHARS > 0 && body.length > MAX_CHARS) {
    body = "…（较早内容已省略，可用 memory_search 查询）\n" + body.slice(-MAX_CHARS);
  }

  return [
    "",
    "## 跨会话记忆（本项目）",
    `已加载 ${longTerm.length} 条长期记忆、今日日志 ${dailyToday.length} 行、开放待办 ${scratchOpen.length} 项。`,
    "使用规则：",
    "- 用户明确说「记住/以后都…/我习惯…」时，立即调用 memory_save，不要只口头确认；",
    "- 涉及本项目历史决策、偏好、约定、踩坑时，先 memory_search 再回答；",
    "- 待办事项用 scratchpad 工具管理（add/done/list）；",
    "- 记忆内容建议带 #标签（如 #偏好 #决策 #约定 #坑）和 [[关键词]] 提升检索效果；",
    "- 保存前先 memory_search 避免重复；记忆膨胀时用 memory_forget 清理（可 memory_restore 恢复）。",
    "",
    body,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // 会话开始时提示记忆状态
  pi.on("session_start", (_event, ctx) => {
    try {
      const cwd = ctx.sessionManager.getCwd();
      const n = loadLongTerm(cwd).length;
      const d = loadDaily(cwd, todayStr()).length;
      const s = loadScratch(cwd).filter((i) => !i.done).length;
      if (n + d + s > 0) ctx.ui.notify(`记忆已加载：长期 ${n} 条 / 今日日志 ${d} 行 / 待办 ${s} 项`, "info");
    } catch {
      /* 会话级错误不影响主流程 */
    }
  });

  // 每轮对话前注入记忆
  pi.on("before_agent_start", (event, ctx) => {
    try {
      const block = buildInjection(ctx.sessionManager.getCwd());
      if (!block) return;
      return { systemPrompt: event.systemPrompt + "\n" + block };
    } catch {
      return undefined;
    }
  });

  // ---- 工具：保存（长期记忆 / 每日日志） ----
  pi.registerTool({
    name: "memory_save",
    label: "保存记忆",
    description:
      "把重要事实、用户偏好、决策、约定写入跨会话永久记忆（按项目隔离）。target=long_term 写长期记忆（决策/偏好/事实，推荐 append）；target=daily 写今日日志（当天工作流水）。当用户说「记住」或你发现值得长期保留的信息时调用。内容一行简洁，建议带 #标签（如 #偏好 #决策 #约定 #坑）和 [[关键词]]。",
    parameters: Type.Object({
      content: Type.String({ description: "要保存的内容，一行，简洁具体" }),
      target: Type.Optional(StringEnum(["long_term", "daily"] as const, { description: "long_term=长期记忆（默认），daily=今日日志" })),
      mode: Type.Optional(StringEnum(["append", "overwrite"] as const, { description: "long_term 的写入模式，默认 append（overwrite 会清空后只留这一条，慎用）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.sessionManager.getCwd();
      const target = params.target ?? "long_term";
      const stamp =
        target === "daily" ? appendDaily(cwd, params.content) : saveLongTerm(cwd, params.content, params.mode ?? "append");
      return {
        content: [{ type: "text", text: `已保存到${target === "daily" ? "今日日志" : "长期记忆"}（项目 ${projectSlug(cwd)}）：\n${stamp}` }],
        details: {},
      };
    },
  });

  // ---- 工具：检索 ----
  pi.registerTool({
    name: "memory_search",
    label: "搜索记忆",
    description:
      "在跨会话记忆中按关键词检索（中文友好：多个关键词用空格分隔，需全部命中同一行；支持 #标签 和 [[链接]]）。范围 all=长期+日志+待办（默认），long_term=仅长期记忆，daily=每日日志，scratchpad=待办。回答涉及历史决策、偏好、约定之前先调用。",
    parameters: Type.Object({
      query: Type.String({ description: "关键词，多个用空格分隔（如：pnpm 包管理）" }),
      scope: Type.Optional(StringEnum(["all", "long_term", "daily", "scratchpad"] as const, { description: "搜索范围，默认 all" })),
      max: Type.Optional(Type.Number({ description: "最多返回条数，默认 20" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.sessionManager.getCwd();
      const scope = params.scope ?? "all";
      const max = Math.min(Math.max(params.max ?? 20, 1), 100);
      const results: string[] = [];

      const collect = (label: string, lines: string[]) => {
        for (const h of searchLines(lines, params.query).slice(0, max - results.length)) {
          results.push(`${label}#${h.line + 1} ${h.text}`);
          if (results.length >= max) return;
        }
      };

      if (scope === "all" || scope === "long_term") collect("长期", loadLongTerm(cwd));
      if (scope === "all" || scope === "daily") {
        for (const f of allDailyFiles(cwd)) collect(`日志${f.slice(0, 10)}`, readLines(dailyFile(cwd, f.slice(0, 10))));
      }
      if (scope === "all" || scope === "scratchpad") collect("待办", loadScratch(cwd).map((i) => `- [${i.done ? "x" : " "}] ${i.text}`));

      if (!results.length) return { content: [{ type: "text", text: "没有找到匹配的记忆条目。" }], details: {} };
      return { content: [{ type: "text", text: `找到 ${results.length} 条：\n${results.join("\n")}` }], details: {} };
    },
  });

  // ---- 工具：列出 ----
  pi.registerTool({
    name: "memory_list",
    label: "列出记忆",
    description:
      "列出跨会话记忆（带行号，供 memory_forget 使用）。target=long_term 长期记忆（默认）、daily 今日日志（可选 date 指定 YYYY-MM-DD）、scratchpad 待办清单、recovery 恢复记录。",
    parameters: Type.Object({
      target: Type.Optional(StringEnum(["long_term", "daily", "scratchpad", "recovery"] as const, { description: "列出范围，默认 long_term" })),
      date: Type.Optional(Type.String({ description: "daily 的日期 YYYY-MM-DD，默认今天" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.sessionManager.getCwd();
      const target = params.target ?? "long_term";
      let text = "";
      if (target === "long_term") {
        const lines = loadLongTerm(cwd);
        text = lines.length ? lines.map((l, i) => `#${i + 1} ${l}`).join("\n") : "还没有长期记忆。";
      } else if (target === "daily") {
        const date = params.date ?? todayStr();
        const lines = loadDaily(cwd, date);
        text = lines.length ? lines.map((l, i) => `#${i + 1} ${l}`).join("\n") : `当日（${date}）没有日志。`;
      } else if (target === "scratchpad") {
        const items = loadScratch(cwd);
        text = items.length
          ? items.map((i, idx) => `#${idx + 1} [${i.done ? "x" : " "}] ${i.text}`).join("\n")
          : "待办清单为空。";
      } else {
        const files = existsSync(recoveryDir(cwd)) ? readdirSync(recoveryDir(cwd)).filter((f) => f.endsWith(".md")) : [];
        text = files.length ? files.map((f, i) => `#${i + 1} ${f.replace(/\.md$/, "")}`).join("\n") : "没有恢复记录。";
      }
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // ---- 工具：删除（可恢复） ----
  pi.registerTool({
    name: "memory_forget",
    label: "删除记忆",
    description:
      "删除跨会话记忆条目（删除前自动生成恢复记录，可用 memory_restore 还原）。按行号（line，见 memory_list）或关键词（query，包含即删）二选一。target 与 memory_list 一致。记忆过时/膨胀/错误时使用。",
    parameters: Type.Object({
      target: Type.Optional(StringEnum(["long_term", "daily", "scratchpad"] as const, { description: "删除范围，默认 long_term" })),
      line: Type.Optional(Type.Number({ description: "行号（1 开始，见 memory_list）" })),
      query: Type.Optional(Type.String({ description: "包含该关键词的条目都会被删除" })),
      date: Type.Optional(Type.String({ description: "daily 的日期 YYYY-MM-DD，默认今天" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.sessionManager.getCwd();
      const target = params.target ?? "long_term";
      const line = params.line !== undefined ? params.line - 1 : undefined;
      if (line === undefined && !params.query) {
        return { content: [{ type: "text", text: "必须提供 line 或 query 参数。" }], details: {} };
      }

      let removed: string[] = [];
      if (target === "daily") {
        const date = params.date ?? todayStr();
        const r = removeFrom(loadDaily(cwd, date), line, params.query);
        writeLines(dailyFile(cwd, date), `# 日志 ${date}`, r.kept);
        removed = r.removed;
      } else if (target === "scratchpad") {
        const items = loadScratch(cwd);
        const r = removeFrom(items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`), line, params.query);
        saveScratch(
          cwd,
          r.kept.map((l) => ({ text: l.replace(/^-\s*\[[ x]\]\s*/i, "").trim(), done: /^-\s*\[x\]/i.test(l) })),
        );
        removed = r.removed;
      } else {
        const r = removeFrom(loadLongTerm(cwd), line, params.query);
        writeLines(longTermFile(cwd), "# 项目长期记忆", r.kept);
        removed = r.removed;
      }

      if (!removed.length) return { content: [{ type: "text", text: "未找到匹配的记忆条目。" }], details: {} };
      const id = writeRecovery(cwd, target, removed);
      return {
        content: [
          {
            type: "text",
            text: `已删除 ${removed.length} 条：\n${removed.join("\n")}\n恢复码：${id}（用 memory_restore 还原）`,
          },
        ],
        details: {},
      };
    },
  });

  // ---- 工具：恢复删除 ----
  pi.registerTool({
    name: "memory_restore",
    label: "恢复记忆",
    description: "按恢复码还原被 memory_forget 删除的记忆条目。恢复码见删除时的返回，或 memory_list target=recovery 查看。",
    parameters: Type.Object({
      id: Type.String({ description: "恢复码（如 recovery 记录的文件名）" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return { content: [{ type: "text", text: restoreRecovery(ctx.sessionManager.getCwd(), params.id) }], details: {} };
    },
  });

  // ---- 工具：待办清单 ----
  pi.registerTool({
    name: "scratchpad",
    label: "待办清单",
    description:
      "管理跨会话待办清单（按项目隔离）。add=新增；done/undo 按 list 显示的序号操作；clear_done=清除已完成；list=列出。用户说「记一下待办/别忘了做…」时用。",
    parameters: Type.Object({
      action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const, { description: "操作类型" }),
      item: Type.Optional(Type.String({ description: "add 时的待办内容" })),
      id: Type.Optional(Type.Number({ description: "done/undo 的序号（list 显示的行号）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.sessionManager.getCwd();
      const items = loadScratch(cwd);
      const action = params.action;

      if (action === "add") {
        if (!params.item) return { content: [{ type: "text", text: "add 需要提供 item。" }], details: {} };
        items.push({ text: params.item, done: false });
        saveScratch(cwd, items);
        return { content: [{ type: "text", text: `已添加待办：${params.item}（共 ${items.filter((i) => !i.done).length} 项未完成）` }], details: {} };
      }
      if (action === "list") {
        if (!items.length) return { content: [{ type: "text", text: "待办清单为空。" }], details: {} };
        return {
          content: [{ type: "text", text: items.map((i, idx) => `#${idx + 1} [${i.done ? "x" : " "}] ${i.text}`).join("\n") }],
          details: {},
        };
      }
      if (action === "clear_done") {
        const n = items.filter((i) => i.done).length;
        saveScratch(cwd, items.filter((i) => !i.done));
        return { content: [{ type: "text", text: `已清除 ${n} 项已完成待办。` }], details: {} };
      }
      if (action === "done" || action === "undo") {
        const id = params.id !== undefined ? params.id - 1 : -1;
        if (id < 0 || id >= items.length) return { content: [{ type: "text", text: "序号无效，先用 scratchpad list 查看序号。" }], details: {} };
        items[id].done = action === "done";
        saveScratch(cwd, items);
        return { content: [{ type: "text", text: `已${action === "done" ? "完成" : "恢复为未完成"}：${items[id].text}` }], details: {} };
      }
      return { content: [{ type: "text", text: "未知操作。" }], details: {} };
    },
  });

  // ---- 工具：状态检查 ----
  pi.registerTool({
    name: "memory_status",
    label: "记忆状态",
    description: "查看记忆系统状态：存储路径、各文件条目数、注入限制与可用环境变量。排查记忆问题时使用。",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const cwd = ctx.sessionManager.getCwd();
      const dir = projectDir(cwd);
      const files = [
        `长期记忆 MEMORY.md：${loadLongTerm(cwd).length} 条`,
        `今日日志：${loadDaily(cwd, todayStr()).length} 行`,
        `待办：${loadScratch(cwd).filter((i) => !i.done).length} 项未完成`,
        `恢复记录：${existsSync(recoveryDir(cwd)) ? readdirSync(recoveryDir(cwd)).filter((f) => f.endsWith(".md")).length : 0} 条`,
      ];
      return {
        content: [
          {
            type: "text",
            text: [
              `项目：${projectSlug(cwd)}`,
              `存储目录：${dir}`,
              ...files,
              `注入上限：${MAX_CHARS > 0 ? MAX_CHARS + " 字符" : "不限"} / 长期 ${MAX_ENTRIES} 条 / 待办 ${MAX_SCRATCH} 条`,
              "环境变量：PI_MEMORY_DIR / PI_MEMORY_MAX_CHARS / PI_MEMORY_MAX_ENTRIES / PI_MEMORY_MAX_SCRATCH",
            ].join("\n"),
          },
        ],
        details: {},
      };
    },
  });
}
