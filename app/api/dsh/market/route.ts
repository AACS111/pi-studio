import { NextResponse } from "next/server";
import { getDshCatalog } from "@/lib/dsh-catalog";

export const dynamic = "force-dynamic";

// GET /api/dsh/market — curated DeepSeek Harness plugin catalog (A/B/C).
export async function GET() {
  const items = getDshCatalog();
  const counts = {
    A: items.filter((i) => i.category === "A").length,
    B: items.filter((i) => i.category === "B").length,
    C: items.filter((i) => i.category === "C").length,
  };
  return NextResponse.json({ items, counts, source: "curated (pi.dev npm ecosystem)" });
}
