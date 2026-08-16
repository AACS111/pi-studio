import { NextResponse } from "next/server";

// Plugin marketplace catalog: scrapes https://pi.dev/packages (server-rendered,
// no public JSON API — "API routes are reserved for future features") and
// parses the package cards into structured data. Query params mirror the site's
// own filter form: name (search text), type, sort (downloads|recent|name).

export const dynamic = "force-dynamic";

const CATALOG_BASE = process.env.PI_DEV_URL || "https://pi.dev/packages";
const TTL_MS = 5 * 60 * 1000; // 5 min
const MAX_RESULTS = 60;
const USER_AGENT = "pi-studio/0.8 (package catalog)";

export interface CatalogPackage {
  name: string;
  description: string;
  author: string;
  downloads: number; // monthly downloads (numeric, from data-package-downloads)
  downloadsLabel: string; // e.g. "354.4K/mo"
  updatedLabel: string; // e.g. "1d ago"
  date: number; // epoch ms
  types: string[]; // extension | skill | theme | prompt
  installSource: string; // e.g. "npm:pi-mcp-adapter"
  npmUrl: string;
  repoUrl: string;
  url: string; // pi.dev detail page
}

const cache = new Map<string, { at: number; items: CatalogPackage[] }>();

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractAttr(html: string, attr: string): string {
  const m = html.match(new RegExp(`${attr}="([^"]*)"`));
  return m ? decodeHtmlEntities(m[1]) : "";
}

function extractBetween(html: string, open: string, close: string): string | null {
  const start = html.indexOf(open);
  if (start === -1) return null;
  const from = start + open.length;
  const end = html.indexOf(close, from);
  if (end === -1) return null;
  return html.slice(from, end);
}

function parseInstallSource(article: string): string {
  const m = article.match(/pi\s+install\s+([^\s<&]+)/);
  return m ? decodeHtmlEntities(m[1]) : "";
}

function parseCards(html: string): CatalogPackage[] {
  const items: CatalogPackage[] = [];
  const articleRe = /<article\b[^>]*data-package-card="true"([\s\S]*?)<\/article>/g;
  let match: RegExpExecArray | null;
  while ((match = articleRe.exec(html)) !== null) {
    const article = match[1];
    const name = extractAttr(article, "data-package-name");
    if (!name) continue;

    const description =
      extractBetween(article, '<p class="packages-desc">', "</p>") ?? "";
    const meta =
      extractBetween(article, '<div class="packages-meta">', "</div>") ?? "";
    const metaSpans = [...meta.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((s) =>
      decodeHtmlEntities(s[1].trim()),
    );

    const badges =
      extractBetween(article, '<div class="packages-badges">', "</div>") ?? "";
    const types = [...badges.matchAll(/data-type="([^"]+)"/g)].map((b) => b[1]);

    const linksBlock =
      extractBetween(article, '<div class="packages-links"', "</div>") ?? "";
    const links = [...linksBlock.matchAll(/href="([^"]+)"/g)].map((l) => l[1]);
    const source = parseInstallSource(article);
    const npmUrl =
      links.find((u) => u.includes("npmjs.com")) ??
      (source.startsWith("npm:")
        ? `https://www.npmjs.com/package/${source.slice(4)}`
        : "");
    const repoUrl =
      links.find(
        (u) => u.startsWith("https://github.com/") && !u.includes("/issues/new"),
      ) ?? "";

    items.push({
      name,
      description: decodeHtmlEntities(description).trim(),
      author: metaSpans[0] ?? "",
      downloads: Number(extractAttr(article, "data-package-downloads")) || 0,
      downloadsLabel: metaSpans[1] ?? "",
      updatedLabel: metaSpans[2] ?? "",
      date: Number(extractAttr(article, "data-package-date")) || 0,
      types,
      installSource: source,
      npmUrl,
      repoUrl,
      url: `https://pi.dev/packages/${name}`,
    });
  }
  return items;
}

// GET /api/packages/catalog?q=&type=&sort=&limit=
export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const type = (url.searchParams.get("type") ?? "").trim();
  const sort = ["downloads", "recent", "name"].includes(
    (url.searchParams.get("sort") ?? "").trim(),
  )
    ? (url.searchParams.get("sort") as string)
    : "downloads";
  const limit = Math.min(
    MAX_RESULTS,
    Math.max(1, Number(url.searchParams.get("limit")) || MAX_RESULTS),
  );

  const cacheKey = `${query}\0${type}\0${sort}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json({ packages: cached.items.slice(0, limit), source: "pi.dev" });
  }

  try {
    const params = new URLSearchParams();
    if (query) params.set("name", query);
    if (type) params.set("type", type);
    params.set("sort", sort);
    const target = `${CATALOG_BASE}?${params.toString()}`;

    const res = await fetch(target, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `pi.dev/packages returned HTTP ${res.status}` },
        { status: 502 },
      );
    }
    const html = await res.text();
    let items = parseCards(html);
    if (sort === "downloads") {
      items = items.sort((a, b) => b.downloads - a.downloads);
    } else if (sort === "recent") {
      items = items.sort((a, b) => b.date - a.date);
    } else {
      items = items.sort((a, b) => a.name.localeCompare(b.name));
    }

    cache.set(cacheKey, { at: Date.now(), items });
    return NextResponse.json({ packages: items.slice(0, limit), source: "pi.dev" });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
