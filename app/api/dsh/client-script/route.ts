import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { loadDshClientManifest, resolveDshClientEntry } from "@/lib/plugins/adapters/dsh/dsh-client-adapter";
import { pluginModulePath, isPluginInstalled } from "@/lib/plugins/adapters/dsh/dsh-plugin-store";

export const dynamic = "force-dynamic";

// GET /api/dsh/client-script?pkg=<name> — 受控返回已安装插件的 client.js 内容。
// 只允许已安装插件（白名单由 dsh-plugin-store 的安装记录 + 包名校验保证），
// 不暴露任意文件。前端 DshClientLoader 用它动态加载 client 入口。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const pkg = (url.searchParams.get("pkg") ?? "").trim();
  if (!pkg || !/^[\w@./-]+$/.test(pkg)) {
    return NextResponse.json({ error: "invalid package" }, { status: 400 });
  }
  if (!isPluginInstalled(pkg)) {
    return NextResponse.json({ error: "not installed" }, { status: 404 });
  }
  const manifest = loadDshClientManifest(pkg);
  const entry = manifest ? resolveDshClientEntry(pkg, manifest) : null;
  if (!entry) {
    return NextResponse.json({ error: "no client entry" }, { status: 404 });
  }
  const file = join(pluginModulePath(pkg), entry);
  try {
    const content = readFileSync(file, "utf8");
    return new NextResponse(content, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "client entry not found" }, { status: 404 });
  }
}
