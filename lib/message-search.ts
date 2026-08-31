import type { AgentMessage } from "./types";

/** 从一条 AgentMessage 提取可用于搜索的纯文本（user/assistant/toolResult/custom）。 */
export function messageSearchText(msg: AgentMessage): string {
  if (msg.role === "user") {
    return typeof msg.content === "string"
      ? msg.content
      : msg.content.map((b) => ("text" in b ? b.text : "")).join(" ");
  }
  if (msg.role === "assistant") {
    return msg.content
      .map((b) =>
        b.type === "text"
          ? b.text
          : b.type === "toolCall"
            ? `${b.toolName} ${JSON.stringify(b.input ?? {})}`
            : "",
      )
      .join(" ");
  }
  if (msg.role === "toolResult") {
    return msg.content.map((b) => ("text" in b ? b.text : "")).join(" ");
  }
  if (msg.role === "custom") {
    return typeof msg.content === "string" ? msg.content : "";
  }
  return "";
}

/** 简易截断，保留 query 命中附近，用于结果摘要展示。 */
export function excerpt(text: string, query: string, max = 80): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.length > max ? `${text.slice(0, max)}…` : text;
  const start = Math.max(0, idx - Math.floor(max / 3));
  const end = Math.min(text.length, start + max);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}
