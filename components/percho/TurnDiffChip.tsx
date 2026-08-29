"use client";
/**
 * components/percho/TurnDiffChip.tsx —— 轮末文件变更 chip（codex 同款）「修改了 N 个文件 +a −d」。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/TurnDiffChip.tsx
 * 简化：不做 diff 侧栏跳转（pi-web 的 ChangedFilesCard 已有完整 diff 查看），仅展示统计 + 文件列表。
 * 扩展：文件路径经 resolveLocalFileHref 解析后可点击 → onOpenFile 在右侧打开。
 */
import type { TurnChanges } from "@/lib/percho";
import { useI18n } from "@/hooks/useI18n";
import { resolveLocalFileHref } from "@/lib/file-links";

const pluralUnit = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function TurnDiffChip({
	changes,
	entering,
	cwd,
	onOpenFile,
}: {
	changes: TurnChanges;
	entering: boolean;
	cwd?: string;
	onOpenFile?: (filePath: string) => void;
}) {
	const { t } = useI18n();
	const fileCount = changes.files.length;

	const handleFileClick = (event: React.MouseEvent<HTMLSpanElement>, path: string) => {
		if (event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const filePath = resolveLocalFileHref(path, cwd);
		if (!filePath) return;
		event.preventDefault();
		onOpenFile?.(filePath);
	};

	return (
		<details className={`turn-diff drawer-details${entering ? " turn-diff-enter" : ""}`}>
			<summary className="turn-diff-head">
				<span className="turn-diff-title">
					{t("diff.filesChanged", { count: fileCount, unit: pluralUnit(fileCount, "file", "files") })}
				</span>
				<span className="turn-diff-stat turn-diff-added">+{changes.totalAdded}</span>
				<span className="turn-diff-stat turn-diff-removed">−{changes.totalRemoved}</span>
				<span className="turn-diff-chev" aria-hidden="true">
					<svg
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.2"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<path d="m9 6 6 6-6 6" />
					</svg>
				</span>
			</summary>
			<div className="turn-diff-files">
				{changes.files.map((f) => {
					const clickable = Boolean(onOpenFile) && Boolean(resolveLocalFileHref(f.path, cwd));
					return (
						<div key={f.path} className="turn-diff-file">
							<span
								className={clickable ? "turn-diff-path turn-diff-path-clickable" : "turn-diff-path"}
								title={f.path}
								onClick={clickable ? (e) => handleFileClick(e, f.path) : undefined}
							>
								{`\u200e${f.path}`}
							</span>
							<span className="turn-diff-stat">
								<span className="turn-diff-added">+{f.added}</span>{" "}
								<span className="turn-diff-removed">−{f.removed}</span>
							</span>
						</div>
					);
				})}
			</div>
		</details>
	);
}
