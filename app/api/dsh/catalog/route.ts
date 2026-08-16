import { NextResponse } from "next/server";

// DSH 生态目录：抓取 https://dsh.deepseek404.com（聚合 GitHub topic:dsh-plugin
// 的第三方商店，服务端渲染无 JSON API），把 project-card 解析成结构化数据。
// 参数镜像站点本身：q（搜索）、category（11 类之一）、page（每页 24 个）。

export const dynamic = "force-dynamic";

const CATALOG_BASE = process.env.DSH_STORE_URL || "https://dsh.deepseek404.com/index.php";
const TTL_MS = 10 * 60 * 1000; // 10 min
const USER_AGENT = "pi-studio/0.8 (dsh catalog)";

export interface DshStoreItem {
  name: string; // repo name
  author: string; // owner
  description: string;
  category: string; // 分类（mono-label）
  type: string; // 类型（完整应用/工具/技能…）
  topics: string[];
  stars: number;
  forks: number;
  issues: number;
  updatedLabel: string;
  repo: string; // "owner/repo"
  githubUrl: string;
  detailUrl: string;
}

export const DSH_STORE_CATEGORIES = [
  "agent-session",
  "communication",
  "data",
  "development",
  "lifestyle",
  "model-mcp",
  "operations",
  "other",
  "research",
  "security",
  "ui",
] as const;

/** 分类 slug → 中文名（站点固定分类，抓自首页 category-row）。 */
export const DSH_STORE_CATEGORY_LABELS: Record<string, string> = {
  "agent-session": "Agent 与会话",
  communication: "消息通讯",
  data: "文件与数据",
  development: "开发工具",
  lifestyle: "生活娱乐",
  "model-mcp": "模型与 MCP",
  operations: "部署运维",
  other: "其他",
  research: "学习研究",
  security: "安全与治理",
  ui: "界面增强",
};

const cache = new Map<string, { at: number; items: DshStoreItem[] }>();

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, "").trim());
}

function extractBetween(html: string, open: string, close: string): string | null {
  const start = html.indexOf(open);
  if (start === -1) return null;
  const from = start + open.length;
  const end = html.indexOf(close, from);
  if (end === -1) return null;
  return html.slice(from, end);
}

function parseNumber(html: string): number {
  const text = stripTags(html).replace(/,/g, "").trim();
  const m = text.match(/^([\d.]+)\s*([kKmM])?$/);
  if (!m) return 0;
  let n = Number(m[1]);
  const suffix = m[2]?.toLowerCase();
  if (suffix === "k") n *= 1000;
  else if (suffix === "m") n *= 1_000_000;
  return Number.isFinite(n) ? n : 0;
}

function parseCards(html: string): DshStoreItem[] {
  const items: DshStoreItem[] = [];
  const articleRe = /<article\b[^>]*class="project-card"[\s\S]*?<\/article>/g;
  let match: RegExpExecArray | null;
  while ((match = articleRe.exec(html)) !== null) {
    const article = match[0];

    // 详情链接里的 id 即 "owner/repo"（URL 编码的 %2F）。
    const detailHref = article.match(/href="detail\.php\?id=([^"]+)"/);
    const repo = detailHref ? decodeURIComponent(decodeHtmlEntities(detailHref[1])) : "";
    if (!repo || !repo.includes("/")) continue;

    const identity = extractBetween(article, 'class="project-card__identity"', "</div>") ?? "";
    const name = stripTags(extractBetween(identity, "<h2>", "</h2>") ?? "") || repo.split("/")[1] || "";
    const author = stripTags(extractBetween(identity, "</h2>", "</div>") ?? "") || repo.split("/")[0] || "";

    const description = stripTags(
      extractBetween(article, 'class="project-card__description">', "</p>") ?? "",
    );

    const category =
      stripTags(extractBetween(article, 'class="mono-label">', "</span>") ?? "") || "other";
    const type =
      stripTags(extractBetween(article, 'class="project-card__type">', "</span>") ?? "") || "";

    const topicsBlock =
      extractBetween(article, 'class="project-card__topics"', "</div>") ?? "";
    const topics = [...topicsBlock.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((s) =>
      stripTags(s[1]),
    );

    const metrics = extractBetween(article, 'class="project-card__metrics"', "</div>") ?? "";
    const metricSpans = [...metrics.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((s) =>
      parseNumber(s[1]),
    );
    const stars = metricSpans[0] ?? 0;
    const forks = metricSpans[1] ?? 0;
    const issues = metricSpans[2] ?? 0;

    const updatedLabel = stripTags(
      extractBetween(article, 'class="project-card__updated">', "</span>") ?? "",
    );

    items.push({
      name,
      author,
      description,
      category,
      type,
      topics,
      stars,
      forks,
      issues,
      updatedLabel,
      repo,
      githubUrl: `https://github.com/${repo}`,
      detailUrl: `https://dsh.deepseek404.com/detail.php?id=${encodeURIComponent(repo)}`,
    });
  }
  return items;
}

// GET /api/dsh/catalog?q=&category=&page=
export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const category = (url.searchParams.get("category") ?? "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);

  const cacheKey = `${query}\0${category}\0${page}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json({ items: cached.items, page, categories: DSH_STORE_CATEGORY_LABELS, source: "dsh.deepseek404.com" });
  }

  try {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (category) params.set("category", category);
    if (page > 1) params.set("page", String(page));
    const target = `${CATALOG_BASE}${params.toString() ? `?${params.toString()}` : ""}`;

    const res = await fetch(target, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `dsh.deepseek404.com returned HTTP ${res.status}` },
        { status: 502 },
      );
    }
    const html = await res.text();
    const items = parseCards(html);

    cache.set(cacheKey, { at: Date.now(), items });
    return NextResponse.json({ items, page, categories: DSH_STORE_CATEGORY_LABELS, source: "dsh.deepseek404.com" });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
