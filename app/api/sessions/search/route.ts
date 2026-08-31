import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { listAllSessions, resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { messageSearchText } from "@/lib/message-search";

const MAX_MATCHES = 40;
// Reading + rebuilding context for every session is expensive; cap how many
// sessions we scan per request so a long history doesn't stall the palette.
const MAX_SESSIONS_SCANNED = 200;

interface ContentMatch {
  sessionId: string;
  sessionName: string;
  cwd: string | null;
  entryId: string;
  role: string;
  snippet: string;
  messageIndex: number;
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim().toLowerCase() ?? "";
  if (!q) return NextResponse.json({ matches: [] });

  try {
    const sessions = await listAllSessions();
    const matches: ContentMatch[] = [];
    let scanned = 0;

    for (const s of sessions) {
      if (matches.length >= MAX_MATCHES || scanned >= MAX_SESSIONS_SCANNED) break;
      let filePath: string | null;
      try {
        filePath = await resolveSessionPath(s.id);
      } catch {
        continue;
      }
      if (!filePath) continue;
      scanned += 1;

      try {
        const sm = SessionManager.open(filePath);
        const ctx = buildSessionContext(sm.getEntries() as never, undefined, {
          deferThinking: true,
          deferToolResultImages: true,
        });
        const { messages, entryIds } = ctx;
        for (let i = 0; i < messages.length; i++) {
          const text = messageSearchText(messages[i]);
          if (!text || !text.toLowerCase().includes(q)) continue;
          matches.push({
            sessionId: s.id,
            sessionName: s.name || s.firstMessage || s.id,
            cwd: s.cwd ?? null,
            entryId: entryIds[i] ?? "",
            role: messages[i].role,
            snippet: text,
            messageIndex: i,
          });
          if (matches.length >= MAX_MATCHES) break;
        }
      } catch {
        // Skip a corrupt/unreadable session rather than failing the whole search.
      }
    }

    return NextResponse.json({ matches });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
