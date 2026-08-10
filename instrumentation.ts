export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Move pi-studio's legacy data (~/.pi/agent/pi-studio-*) into the project-local,
  // configurable data dir (default <project>/pi-web-uploads) before anything
  // starts writing to the new location (open-file marker, univer daemon home, …).
  try {
    const { migrateLegacyData } = await import("./lib/storage-config");
    migrateLegacyData();
  } catch {
    /* best-effort */
  }

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Warm the univer daemon in the background so the first .univer command from
  // the user isn't paying the cold-start cost (~4s + race retries). The warm-up
  // is idempotent and failure-tolerant (see lib/univer-cli.ts); boot must never
  // fail because of it.
  try {
    const { warmUpUniverDaemon } = await import("./lib/univer-cli");
    void warmUpUniverDaemon();
  } catch {
    /* best-effort */
  }

  // Auto-start the browser-use sidecar (127.0.0.1:17865) so the agent can drive
  // a real headless Chrome (open/click/type/screenshot). Idempotent — skips when
  // the port is already served — and failure-tolerant, so boot never blocks on it.
  try {
    const { ensureBrowserSidecar } = await import("./lib/browser-sidecar");
    void ensureBrowserSidecar();
  } catch {
    /* best-effort */
  }
}
