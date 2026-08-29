"use client";
/**
 * components/percho/RetryNote.tsx —— 自动重试瞬时状态行（琥珀旋转 glyph + 文案）。
 * 来源：percho packages/desktop/src/renderer/src/components/chat/RetryNote.tsx
 */
import type { RetryInfo } from "@/lib/percho";
import { useI18n } from "@/hooks/useI18n";
import { RefreshIcon } from "./icons";

export function RetryNote({ info }: { info: RetryInfo }) {
	const { t } = useI18n();
	return (
		<div className="retry-note" role="status">
			<RefreshIcon />
			<span>
				{t("error.retrying", {
					attempt: info.attempt,
					maxAttempts: info.maxAttempts,
					delay: Math.ceil(info.delayMs / 1000),
				})}
			</span>
		</div>
	);
}
