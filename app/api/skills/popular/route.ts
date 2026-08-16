import { NextResponse } from "next/server";
import type { SkillSearchResult } from "@/lib/api-types";

// Popular skills: scrapes the skills.sh homepage leaderboard (All Time) — the
// site exposes no JSON API for trending, but the leaderboard rows are
// server-rendered: rank | skill name | source org | installs.

export const dynamic = "force-dynamic";

const SKILLS_HOME = process.env.SKILLS_URL || "https://skills.sh";
const TTL_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;
const USER_AGENT = "pi-studio/0.8 (skill leaderboard)";

const cache = new Map<string, { at: number; items: SkillSearchResult[] }>();

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function parseLimit(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(num)));
}

// Leaderboard row pattern (minified markup):
// <a class="group grid ..." href="/<source>/<name>">
//   ... <span class="...font-mono">1</span>            rank
//   ... <h3 class="...">find-skills</h3>               name
//   ... <p class="...">vercel-labs/skills</p>          source org
//   ... <span class="font-mono text-sm text-foreground">3.0M</span>  installs
const ROW_RE =
  /<a class="group grid[\s\S]*?href="\/([^"]+)">[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<span class="font-mono text-sm text-foreground">([\s\S]*?)<\/span>/g;

function parseLeaderboard(html: string): SkillSearchResult[] {
  const items: SkillSearchResult[] = [];
  let match: RegExpExecArray | null;
  while ((match = ROW_RE.exec(html)) !== null) {
    const slug = match[1].trim();
    const name = decodeHtmlEntities(match[2]).trim();
    const source = decodeHtmlEntities(match[3]).trim();
    const installs = decodeHtmlEntities(match[4]).trim();
    if (!slug || !name || !source || !installs) continue;
    items.push({
      package: `${source}@${name}`,
      installs: `${installs} installs`,
      url: `${SKILLS_HOME}/${slug}`,
    });
  }
  return items;
}

// GET /api/skills/popular?limit=
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get("limit"));

  const cached = cache.get("leaderboard");
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json({ results: cached.items.slice(0, limit) });
  }

  try {
    const res = await fetch(SKILLS_HOME, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      cache: "no-store",
      redirect: "follow",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `skills.sh returned HTTP ${res.status}` },
        { status: 502 },
      );
    }
    const html = await res.text();
    const items = parseLeaderboard(html);
    if (items.length === 0) {
      return NextResponse.json(
        { error: "No leaderboard data found on skills.sh" },
        { status: 502 },
      );
    }
    cache.set("leaderboard", { at: Date.now(), items });
    return NextResponse.json({ results: items.slice(0, limit) });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
