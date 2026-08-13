/**
 * Shared URL helpers for pi-studio's right-panel browser (web preview).
 *
 * 右侧浏览器仅在 Electron 桌面模式可用（WebContentsView + 原生控制桥），
 * npm run dev 纯浏览器模式不支持右端浏览器。这里的 normalizeUserUrl 供
 * /api/browser marker 路由和右侧面板地址栏共用。
 */

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Normalize a user-typed / agent-provided address into an absolute http(s)
 * URL, or null when it is empty or not a web address. Adds "https://" when no
 * scheme is present (e.g. "example.com/page" or "localhost:5173").
 */
export function normalizeUserUrl(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  let candidate = raw;
  // Bare hostname / host:port / path → assume https.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    candidate = "https://" + candidate;
  }
  try {
    const url = new URL(candidate);
    if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}
