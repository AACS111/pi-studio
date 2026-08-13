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

  // 右侧浏览器由 Electron 原生 WebContentsView + 控制桥提供（electron/main.cjs 启动
  // bridge.cjs），npm run dev 纯浏览器模式不支持右端浏览器——无需任何后台侧车。
}
