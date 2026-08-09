"use client";

import { Suspense, useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { FileViewer } from "@/components/FileViewer";
import { I18nProvider, useI18n } from "@/hooks/useI18n";

/**
 * Standalone full-window file viewer — opened from the right file panel's
 * "open in new tab" button (/file?path=...&cwd=...&session=...). Renders the
 * same FileViewer as the in-app panel but with the whole viewport to itself,
 * which is handy for wide spreadsheets or second-monitor setups.
 */
function FilePageInner() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [filePath, setFilePath] = useState<string | null>(() => searchParams.get("path"));
  const cwdParam = searchParams.get("cwd");
  const sessionParam = searchParams.get("session");
  const cwd = cwdParam || undefined;
  const sourceSessionId = sessionParam || undefined;

  const handleOpenFile = useCallback((path: string) => {
    setFilePath(path);
    const params = new URLSearchParams({ path });
    if (cwdParam) params.set("cwd", cwdParam);
    if (sessionParam) params.set("session", sessionParam);
    router.replace(`/file?${params.toString()}`, { scroll: false });
  }, [cwdParam, router, sessionParam]);

  if (!filePath) {
    return (
      <div style={{ height: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, background: "var(--bg)", color: "var(--text-muted)", fontSize: 13 }}>
        <div>{t("files.standaloneNoFile")}</div>
        <Link href="/" style={{ color: "var(--accent)" }}>{t("files.backToApp")}</Link>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "var(--bg)" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        height: 40, padding: "0 12px", flexShrink: 0,
        background: "var(--bg-panel)", borderBottom: "1px solid var(--border)",
        fontSize: 12, color: "var(--text-muted)",
      }}>
        <Link
          href="/"
          title={t("files.backToApp")}
          style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", textDecoration: "none", cursor: "pointer", whiteSpace: "nowrap" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {t("files.backToApp")}
        </Link>
        <span style={{ flexShrink: 0, color: "var(--border)", userSelect: "none" }}>|</span>
        <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={filePath}>
          {filePath}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <FileViewer
          filePath={filePath}
          cwd={cwd}
          sourceSessionId={sourceSessionId}
          onOpenFile={handleOpenFile}
        />
      </div>
    </div>
  );
}

export default function FilePage() {
  return (
    <Suspense>
      <I18nProvider>
        <FilePageInner />
      </I18nProvider>
    </Suspense>
  );
}
