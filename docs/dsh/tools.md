# DSH Tool 契约（ctx.tools）

来源：`@deepseek-ai/dsh-tools@0.0.1-rc.1`（`defineTool` / `ToolRegistry`）+
`@deepseek-ai/dsh-tool-fs@0.0.1-rc.1`（真实 tool 插件样本）。

## 注册路径

```ts
// 插件 apply 里：
ctx.tools.register(defineTool({
  name: "read",
  description: "Read a UTF-8 text file…",
  parameters: { file_path: { type: "string", required: true, … } },
  output: { schema, render, presentationMeta },
  isConcurrencySafe: () => true,
  async execute(args, exec) { … },
  presentCall(args) { … },
  presentResult(args, result) { … },
}));
```

- `ctx.tools` 是 `ToolRegistry` Service（`super(ctx, "tools")`）。
- `defineTool(...)` 来自 `@deepseek-ai/dsh-tools`，返回带 `.name` 的工具定义。
- `ToolRegistry.register(definition)` 按 `definition.name` 插入。

## Tool 定义关键字段

| 字段 | 作用 |
| --- | --- |
| `name` | 工具名（模型可见） |
| `description` | 模型路由描述 |
| `parameters` | 入参 schema（`type`/`required`/`description`） |
| `output.schema` | 出参 JSON schema |
| `output.render` | 模型可见文本渲染 |
| `execute(args, exec)` | **真正的执行体**，Pi 适配器要 hook 的是这里 |
| `isConcurrencySafe` | 并发安全声明 |

## `exec`（ToolExecutionInput）字段

`execute(args, exec)` 的 `exec` 里，dsh-tool-fs 实际用到：
- `exec.agent?.session.header.cwd` —— 会话工作目录（无 agent 时为 undefined）
- `exec.signal` —— AbortSignal
- `exec.callId` —— 调用 id

## dsh-tool-fs 的真实依赖（实证）

```ts
export const name = "tool-fs";
export const inject = ["tools", "fs", "systemPrompt"];  // 三个服务
export const Config = z.object({
  readLimit: z.number().default(2000),
  readMaxLineLength: z.number().default(2000),
  readMaxBytes: z.number().default(50*1024),
  readStreamMinSize: z.number().default(10*1024*1024),
});
export function apply(ctx, config) { /* 注册 read/write/edit */ }
```

它对 `ctx` 的用法（Phase 1 适配器必须满足的最小面）：
- `ctx.tools.register(...)`
- `ctx.systemPrompt.section({ name, order, text })`
- `ctx.fs.resolve / stat / readText / streamText / writeText / editText / sandboxMode`
- `ctx.emit("fs/observed", ...)`、`ctx.waterfall("fs/write-intent" | "fs/edit-intent", ...)`
- `ctx.get("sandboxPolicy" | "approval")`（仅沙箱后端）

## 对 Pi 的意义

`execute(args, exec)` 就是「真实 DSH Tool 调用 Pi 能力」的边界。Pi 的 `ctx.fs`
Service 实现决定工具落在哪个文件系统上——换成 `lib/file-access.ts` 的允许根校验，
DSH 工具就自动受 Pi 的安全边界约束，而不是 DSH 的沙箱。

这也是「DSH 插件调用的是 Pi 的能力，而不是 DSH 的能力」的具体体现：
`dsh-tool-fs` 的 read/write/edit 逻辑完全复用，但底下的 `ctx.fs` 是 Pi 的。
