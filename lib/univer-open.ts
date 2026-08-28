import { runUniver } from "./univer-cli";

/** Official gateway viewer URLs are loopback-only (e.g. http://127.0.0.1:9126/?file=...). */
const VIEWER_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/\?/;

/** Resolved URLs are stable while the daemon lives; caching them skips a CLI
 *  roundtrip (hundreds of ms warm, tens of seconds cold) per repeat open.
 *  A loopback liveness probe (see below) bounds the stale-window after a
 *  daemon restart (port changes), so the TTL can stay generous. */
const viewerUrlCache = new Map<string, { url: string; at: number }>();
const VIEWER_URL_TTL_MS = 15 * 60 * 1000;

/** Cheap loopback probe: a cached URL is only reused while the daemon that
 *  serves it is actually up. After a daemon restart the old port is dead and
 *  the fetch fails within the timeout, so we fall through to a fresh `open`
 *  instead of handing the iframe a dead URL. Normal hit costs ~5-20ms. */
async function isViewerUrlAlive(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The CLI prints one JSON object per result — but under daemon warm-up races it
 * can also emit progress lines, so parse the last non-empty line defensively.
 */
function parseLastJson<T>(stdout: string): T {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]) as T;
    } catch {
      /* not JSON — keep scanning upwards */
    }
  }
  throw new Error("univer CLI returned no JSON output");
}

export interface UniverUnitInfo {
  unitId: string;
  /** "sheet" | "doc" | "slide" | "base" | "board" */
  kind: string;
  name?: string;
}

/**
 * List the top-level units of a `.univer` file (trunk or a specific worktree)
 * via `univer unit list --json`.
 */
export async function listUniverUnits(file: string, worktree?: string): Promise<UniverUnitInfo[]> {
  const args = ["unit", "list", file];
  if (worktree) args.push("--worktree", worktree);
  args.push("--json");
  const stdout = await runUniver(args);
  try {
    const parsed = parseLastJson<{ units?: unknown }>(stdout);
    const rawUnits = parsed.units;
    return Array.isArray(rawUnits)
      ? rawUnits
          .filter((u): u is Record<string, unknown> => typeof u === "object" && u !== null)
          .map((u) => ({
            unitId: String(u.unitId ?? ""),
            kind: String(u.kind ?? "").toLowerCase(),
            name: typeof u.name === "string" ? u.name : undefined,
          }))
          .filter((u) => u.unitId && u.kind)
      : [];
  } catch {
    return [];
  }
}

/**
 * Resolve the official Collab-Gateway viewer URL (`univer open --json`) for a
 * file/worktree/unit target. The URL points at the univer daemon's loopback
 * gateway and can be embedded in an iframe.
 */
export async function resolveViewerUrl(target: { file: string; worktree?: string; unit?: string }): Promise<string> {
  const cacheKey = `${target.file}|${target.worktree ?? ""}|${target.unit ?? ""}`;
  const cached = viewerUrlCache.get(cacheKey);
  if (cached && Date.now() - cached.at < VIEWER_URL_TTL_MS) {
    if (await isViewerUrlAlive(cached.url)) return cached.url;
    viewerUrlCache.delete(cacheKey); // daemon restarted — re-resolve below
  }

  const args = ["open", target.file];
  if (target.worktree) args.push("--worktree", target.worktree);
  if (target.unit) args.push("--unit", target.unit);
  args.push("--json");
  const stdout = await runUniver(args);
  const parsed = parseLastJson<{ ok?: boolean; openUrl?: string }>(stdout);
  if (!parsed.ok || typeof parsed.openUrl !== "string" || !VIEWER_URL_RE.test(parsed.openUrl)) {
    throw new Error("open command returned no usable viewer URL");
  }
  viewerUrlCache.set(cacheKey, { url: parsed.openUrl, at: Date.now() });
  return parsed.openUrl;
}
