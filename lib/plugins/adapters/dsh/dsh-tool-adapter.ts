/**
 * DSH tool → pi ToolDefinition 桥接。
 *
 * 关键事实（docs/dsh/tools.md）：dsh-tools 的 `defineTool()` 已经把插件的
 * `parameters`（ParameterSchemaSpec）转成**标准 JSON Schema**（`{type:"object",
 * properties, required}`），且把 `execute` 包装成「先 validate args 再执行」。
 * 所以桥接侧只需做两件事：
 *   1. 标准 JSON Schema → TypeBox TSchema（pi 的 parameters 类型）
 *   2. execute 签名桥接：DSH `execute(args, exec)` → pi `execute(toolCallId,
 *      params, signal, onUpdate, ctx)`，结果包成 `AgentToolResult { content, details }`。
 *
 * 桥接后可直接作为 `createAgentSessionFromServices({ customTools })` 注入 pi agent。
 */
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DshTool } from "./dsh-runtime";

/** 标准 JSON Schema 节点（defineTool 转换后的 parameters 形态）。 */
interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  enum?: readonly unknown[];
  description?: string;
  oneOf?: readonly JsonSchemaNode[];
  additionalProperties?: boolean | JsonSchemaNode;
}

/** 标准 JSON Schema → TypeBox。 */
function jsonSchemaToTypeBox(node: JsonSchemaNode): TSchema {
  if (!node || typeof node !== "object") return Type.Any();

  if (node.enum && node.enum.length > 0) {
    const literals: TSchema[] = [];
    let hasNull = false;
    for (const v of node.enum) {
      if (v === null) { hasNull = true; continue; }
      literals.push(Type.Literal(v as string | number | boolean));
    }
    if (hasNull) literals.push(Type.Null());
    return literals.length > 1 ? Type.Union(literals) : literals[0];
  }

  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case "string":
      return node.description ? Type.String({ description: node.description }) : Type.String();
    case "number":
      return node.description ? Type.Number({ description: node.description }) : Type.Number();
    case "integer":
      return node.description ? Type.Integer({ description: node.description }) : Type.Integer();
    case "boolean":
      return node.description ? Type.Boolean({ description: node.description }) : Type.Boolean();
    case "null":
      return Type.Null();
    case "array":
      return Type.Array(node.items ? jsonSchemaToTypeBox(node.items) : Type.Any());
    case "object": {
      const required = new Set(node.required ?? []);
      const props: Record<string, TSchema> = {};
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        const schema = jsonSchemaToTypeBox(child);
        props[key] = required.has(key) ? schema : Type.Optional(schema);
      }
      return Type.Object(props, { additionalProperties: node.additionalProperties === true });
    }
    default:
      return Type.Any();
  }
}

/** DSH 工具参数（标准 JSON Schema）→ TypeBox TSchema。 */
export function dshParametersToTypeBox(parameters: unknown): TSchema {
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
    return jsonSchemaToTypeBox(parameters as JsonSchemaNode);
  }
  return Type.Object({}, { additionalProperties: true });
}

/** 把 DSH 工具的 execute 结果渲染成模型可见文本。 */
function renderDshResult(tool: DshTool, args: unknown, value: unknown): string {
  if (tool.output?.render) {
    try {
      const parts = tool.output.render(args, value);
      if (Array.isArray(parts)) {
        return parts
          .map((p) => (p && typeof p === "object" && (p as { text?: unknown }).text !== undefined
            ? String((p as { text: unknown }).text)
            : JSON.stringify(p)))
          .join("");
      }
    } catch {
      // fall through to JSON
    }
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * 把一个 DSH 工具桥接成 pi ToolDefinition。
 * 返回 null 表示该工具无法桥接（缺 name/execute）。
 */
export function dshToolToPiTool(tool: DshTool): ToolDefinition | null {
  if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") {
    return null;
  }

  const definition = {
    name: tool.name,
    label: tool.name,
    description: tool.description ?? "",
    parameters: dshParametersToTypeBox(tool.parameters),
    async execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> {
      void _onUpdate;
      void _ctx;
      const exec = { signal, callId: toolCallId, agent: undefined };
      const value = await tool.execute(params, exec);
      return {
        content: [{ type: "text", text: renderDshResult(tool, params, value) }],
        details: value,
      };
    },
  };

  return definition as unknown as ToolDefinition;
}

/** 批量桥接，过滤掉无法桥接的工具。 */
export function dshToolsToPiTools(tools: DshTool[]): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const tool of tools) {
    const bridged = dshToolToPiTool(tool);
    if (bridged) out.push(bridged);
  }
  return out;
}
