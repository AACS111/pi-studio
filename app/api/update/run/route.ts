import { NextResponse } from "next/server";
import { runAppUpdate } from "@/lib/update-manager";

export const dynamic = "force-dynamic";

/** POST /api/update/run — 把全局安装的 pi-studio 更新到指定版本（默认 npm 最新）。
 *  源码/开发模式（本仓库直接运行）拒绝自动更新，提示手动 git pull && npm install。 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { version?: unknown };
    const version = typeof body.version === "string" && body.version ? body.version : undefined;
    const result = await runAppUpdate(version);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const alreadyUpToDate = message.startsWith("Already on");
    return NextResponse.json({ error: message }, { status: alreadyUpToDate ? 400 : 500 });
  }
}
