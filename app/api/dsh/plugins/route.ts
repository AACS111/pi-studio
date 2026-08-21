import { NextResponse } from "next/server";
import { installPlugin, removePlugin, listInstalledPlugins } from "@/lib/plugins/adapters/dsh/dsh-plugin-store";
import { loadDshPlugin, ensureDshPluginsLoaded } from "@/lib/plugins/adapters/dsh/dsh-adapter";
import { registerDshClientExtension } from "@/lib/plugins/adapters/dsh/dsh-client-adapter";
import { registerPlugin, unregisterPlugin, listPlugins } from "@/lib/plugins/core/plugin-registry";
import { unregisterPluginExtensions } from "@/lib/plugins/ui/ui-registry";
import { detectDshPackage } from "@/lib/plugins/adapters/dsh/dsh-detect";

export const dynamic = "force-dynamic";

// GET /api/dsh/plugins — installed DSH plugins + loaded/bridged artifacts.
// 先确保已安装插件已加载（幂等；UI 刷新插件列表即触发加载，不依赖会话创建）。
export async function GET() {
  await ensureDshPluginsLoaded();
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
    // 安装前强制适配检测：只有能被 DSH Adapter 承载的插件才允许安装。
    const report = await detectDshPackage(pkg);
    if (!report.adaptable) {
      return NextResponse.json(
        {
          error: report.reason,
          report,
        },
        { status: 409 },
      );
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
      // 若插件带 dsh.client manifest，顺带注册 Pi UI 扩展（sidebar 条目）。
      const clientExt = registerDshClientExtension(pkg);
      return NextResponse.json({
        success: true,
        installed: listInstalledPlugins(),
        loaded: {
          package: pkg,
          compat: result.compat,
          toolCount: result.artifacts.tools.length,
          skillCount: result.artifacts.skillPaths.length,
          ui: clientExt != null,
        },
      });
    } catch (error) {
      // 纯 client UI 插件：无 host 入口（normalizeDshModule 返回 null → throw），
      // 但有 dsh.client manifest 时仍可注册为 Pi UI 扩展。
      const clientExt = registerDshClientExtension(pkg);
      if (clientExt) {
        return NextResponse.json({
          success: true,
          installed: listInstalledPlugins(),
          loaded: {
            package: pkg,
            compat: {
              score: 100,
              verified: false,
              unmapped: [],
              notes: ["client-ui plugin; registered as Pi UI extension (no host entry)"],
            },
            toolCount: 0,
            skillCount: 0,
            ui: true,
          },
        });
      }
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
  unregisterPluginExtensions(`dsh:${pkg}`);
  return NextResponse.json({ success: true, installed: listInstalledPlugins() });
}
