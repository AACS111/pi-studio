import { NextResponse } from "next/server";
import { installPlugin, removePlugin, listInstalledPlugins } from "@/lib/plugins/adapters/dsh/dsh-plugin-store";
import { loadDshPlugin } from "@/lib/plugins/adapters/dsh/dsh-adapter";
import { registerPlugin, unregisterPlugin, listPlugins } from "@/lib/plugins/core/plugin-registry";
import { installUiPlugin, startDshUi } from "@/lib/dsh-ui-runtime";

export const dynamic = "force-dynamic";

/** 读 npm registry 元数据，判断包是否 UI 插件（dsh.client.platform === "web"）。 */
async function isUiPlugin(pkg: string): Promise<boolean> {
  const url = `https://registry.npmjs.org/${pkg.replace("/", "%2F")}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pi-studio/0.8", Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as {
      "dist-tags"?: { latest?: string };
      versions?: Record<string, { dsh?: { client?: { platform?: string } } }>;
    };
    const latest = json["dist-tags"]?.latest;
    const v = latest ? json.versions?.[latest] : undefined;
    return v?.dsh?.client?.platform === "web";
  } catch {
    return false;
  }
}

// GET /api/dsh/plugins — installed DSH plugins + loaded/bridged artifacts.
export async function GET() {
  return NextResponse.json({
    installed: listInstalledPlugins(),
    loaded: listPlugins()
      .filter((p) => p.origin === "dsh")
      .map((p) => ({
        id: p.id,
        package: p.name,
        version: p.version,
        compat: p.compat,
        toolCount: p.artifacts?.tools.length ?? 0,
        skillCount: p.artifacts?.skillPaths.length ?? 0,
      })),
  });
}

// POST /api/dsh/plugins — { action: "install" | "remove", package: string }
// Installs/removes via npm into the isolated store, then loads/bridges so the
// plugin's tools are available to new sessions immediately.
export async function POST(req: Request) {
  let body: { action?: string; package?: string };
  try {
    body = (await req.json()) as { action?: string; package?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const action = body.action === "remove" ? "remove" : "install";
  const pkg = (body.package ?? "").trim();
  if (!pkg) return NextResponse.json({ error: "package required" }, { status: 400 });

  if (action === "install") {
    // UI 插件（面板/皮肤等）走 DSH Web UI 运行时；tool/skill 插件走 Cordis 桥接。
    if (await isUiPlugin(pkg)) {
      const inst = await installUiPlugin(pkg);
      if (!inst.ok) {
        return NextResponse.json({ error: inst.output }, { status: 500 });
      }
      const snapshot = await startDshUi();
      return NextResponse.json({
        success: true,
        ui: true,
        package: pkg,
        url: snapshot.url,
        status: snapshot.status,
        error: snapshot.error,
      });
    }

    const installResult = await installPlugin(pkg);
    if (!installResult.ok) {
      return NextResponse.json({ error: installResult.output }, { status: 500 });
    }
    try {
      const result = await loadDshPlugin(pkg);
      registerPlugin({
        id: `dsh:${pkg}`,
        origin: "dsh",
        name: pkg,
        version: result.artifacts.version,
        compat: result.compat,
        artifacts: result.artifacts,
        loadedAt: Date.now(),
      });
      return NextResponse.json({
        success: true,
        installed: listInstalledPlugins(),
        loaded: {
          package: pkg,
          compat: result.compat,
          toolCount: result.artifacts.tools.length,
          skillCount: result.artifacts.skillPaths.length,
        },
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  // remove
  const removeResult = await removePlugin(pkg);
  if (!removeResult.ok) {
    return NextResponse.json({ error: removeResult.output }, { status: 500 });
  }
  unregisterPlugin(`dsh:${pkg}`);
  return NextResponse.json({ success: true, installed: listInstalledPlugins() });
}
