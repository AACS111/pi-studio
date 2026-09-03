/**
 * lib/thinking.ts —— `deferThinking` 剔掉的「思考正文」按需拉取（带 LRU 缓存）。
 *
 * 历史负载里 thinking 块被后端置空（`{ thinking: "", deferred: true }`），
 * 用户展开「思考过程」那一刻才打这一枪。旧版 MessageView 与 percho ThinkingRow 共用。
 */
const MAX_CACHE_ENTRIES = 100;
const cache = new Map<string, Promise<string>>();

export function loadThinkingContent(
	sessionId: string,
	entryId: string,
	blockIndex: number,
): Promise<string> {
	const key = `${sessionId}:${entryId}:${blockIndex}`;
	const cached = cache.get(key);
	if (cached) {
		// LRU 触达：移到队尾
		cache.delete(key);
		cache.set(key, cached);
		return cached;
	}

	const request = fetch(
		`/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
	)
		.then(async (response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = (await response.json()) as { thinking?: unknown };
			if (typeof data.thinking !== "string") throw new Error("Invalid thinking response");
			return data.thinking;
		})
		.catch((error) => {
			cache.delete(key);
			throw error;
		});

	cache.set(key, request);
	if (cache.size > MAX_CACHE_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== key && oldest !== undefined) cache.delete(oldest);
	}
	return request;
}
