import { NextResponse } from "next/server";
import { checkAppUpdate } from "@/lib/update-manager";

export const dynamic = "force-dynamic";

/** GET /api/update/check — 检查 pi-studio 应用自身是否有新版本（npm registry） */
export async function GET() {
  try {
    const info = await checkAppUpdate();
    return NextResponse.json(info);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
