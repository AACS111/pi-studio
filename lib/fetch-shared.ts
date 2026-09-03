/**
 * lib/fetch-shared.ts —— 同一 URL 的「在飞」GET 请求合并成一次。
 *
 * 场景：打开会话时要拉 `/api/sessions/[id]`（大会话几 MB）。dev 模式下 React
 * StrictMode 会把挂载副作用跑两遍，多个调用方也会在同一帧里各自 loadSession，
 * 结果同一个负载被下载 + JSON.parse 两次，首屏耗时直接翻倍。
 *
 * 只合并「正在进行中」的请求（落地即从表里移除），不缓存结果，数据新鲜度不变；
 * 返回的是同一份解析后的对象，调用方只读不写。
 */
export interface SharedJsonResult<T> {
  status: number;
  /** 非 2xx 时为 null（404 与其它错误码都靠 status 区分，由调用方决定怎么处理） */
  data: T | null;
}

const inflight = new Map<string, Promise<SharedJsonResult<unknown>>>();

export function fetchJsonShared<T>(url: string): Promise<SharedJsonResult<T>> {
  const existing = inflight.get(url);
  if (existing) return existing as Promise<SharedJsonResult<T>>;

  const promise: Promise<SharedJsonResult<unknown>> = (async () => {
    const res = await fetch(url);
    if (!res.ok) return { status: res.status, data: null };
    return { status: res.status, data: await res.json() };
  })().finally(() => {
    if (inflight.get(url) === promise) inflight.delete(url);
  });

  inflight.set(url, promise);
  return promise as Promise<SharedJsonResult<T>>;
}
