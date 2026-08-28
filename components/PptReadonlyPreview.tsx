"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getRelativeFilePath } from "@/lib/file-paths";
import { DownloadLink } from "./FileViewer";

/**
 * PptReadonlyPreview — .ppt/.pptx 的只读预览。
 *
 * pi-studio 没有原生 pptx 渲染器（mammoth 只做 docx），所以转换副本放在数据
 * 目录的隐藏缓存（.internal/univer-view-cache/，不会出现在任何文件/上传列表
 * 里），通过 univer-cli 守护进程的 Collab Gateway 官方查看器 iframe 嵌入展示
 * —— 变更记录直接用网关自带看板（用户决定 2026-08-27）。点「AI 编辑」才走
 * POST /api/univer/from-xlsx 生成正式的 -ai-edit.univer 进入 worktree 工作流。
 */

interface Props {
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  /** 「AI 编辑」handler（AppShell.handleAiEdit：转 .univer 并切换到编辑视图）。 */
  onAiEdit?: (pptPath: string) => Promise<void> | void;
}

export function PptReadonlyPreview({ filePath, cwd, sourceSessionId, onAiEdit }: Props) {
  const { t } = useI18n();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const notifiedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setPreviewUrl(null);
    setError("");

    fetch("/api/univer/ppt-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: filePath }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { file?: string; url?: string; error?: string };
        if (!res.ok || !data.file || !data.url) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setPreviewUrl(data.url);
        setState("ok");
      })
      .catch((err) => {
        if (cancelled) return;
        setState("error");
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => { cancelled = true; };
  }, [filePath]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* 工具条：路径 + 只读预览标签 + AI 编辑 + 下载 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-dim)",
          background: "var(--bg)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span>{t("files.pptPreview")}</span>
        {onAiEdit && (
          <button
            type="button"
            onClick={() => {
              setAiError("");
              setAiBusy(true);
              notifiedRef.current = false;
              Promise.resolve(onAiEdit(filePath))
                .catch((e) => setAiError(e instanceof Error ? e.message : String(e)))
                .finally(() => setAiBusy(false));
            }}
            disabled={aiBusy}
            title={t("files.aiEditTitle")}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "3px 10px",
              background: "none", border: "1px solid var(--border)", borderRadius: 7,
              fontSize: 11,
              color: aiBusy ? "var(--text-dim)" : "var(--accent)",
              fontWeight: 600, cursor: aiBusy ? "default" : "pointer",
              flexShrink: 0,
            }}
          >
            {aiBusy ? (
              <span style={{ width: 11, height: 11, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite", display: "inline-block" }} />
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
                <circle cx="12" cy="12" r="4" />
              </svg>
            )}
            {aiBusy ? t("files.aiEditBusy") : t("files.aiEdit")}
          </button>
        )}
        <span style={{ marginLeft: "auto" }}><DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} /></span>
      </div>
      {aiError && (
        <div role="alert" style={{ margin: "6px 16px 0", padding: "6px 10px", background: "color-mix(in srgb, #ef4444 10%, transparent)", border: "1px solid color-mix(in srgb, #ef4444 35%, transparent)", borderRadius: 8, fontSize: 11.5, color: "#ef4444", wordBreak: "break-word" }}>
          {aiError}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {state === "loading" && (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--text-dim)", fontSize: 12 }}>
            <span aria-hidden="true" style={{ width: 16, height: 16, border: "2px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite", display: "inline-block" }} />
            {t("files.pptPreviewLoading")}
          </div>
        )}
        {state === "error" && (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
            <div role="alert" style={{ maxWidth: 420, padding: "10px 14px", background: "color-mix(in srgb, #ef4444 10%, transparent)", border: "1px solid color-mix(in srgb, #ef4444 35%, transparent)", borderRadius: 9, fontSize: 12, lineHeight: 1.5, color: "#ef4444", wordBreak: "break-word" }}>
              {t("files.pptPreviewFailed")}
              {error ? `: ${error}` : ""}
            </div>
          </div>
        )}
        {state === "ok" && previewUrl && (
          <iframe
            src={previewUrl}
            title={t("files.pptPreview")}
            style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>
    </div>
  );
}
