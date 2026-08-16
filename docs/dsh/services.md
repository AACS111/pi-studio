# ctx 服务清单与能力契约

来源：`@deepseek-ai/dsh-base/cordis.patch.yml` + 各 Service 的 `lib/types/*.d.ts`。

## 已实证的 ctx 服务名（`super(ctx, name)` 字面量）

| 服务名 | 提供者 | 契约要点 |
| --- | --- | --- |
| `fs` | `@deepseek-ai/dsh-fs` | 抽象 `FileSystem`，见下 |
| `tools` | `@deepseek-ai/dsh-tools` | `ToolRegistry.register(definition)`，见 tools.md |
| `systemPrompt` | `@deepseek-ai/dsh-system-prompt` | `SystemPrompt.section({name,order,text})` |
| `skills` | `@deepseek-ai/dsh-skill` | 分层 `SkillService`，见 skills.md |

## 惰性服务（仅沙箱后端需要）

`dsh-tool-fs` 里 `ctx.get("sandboxPolicy")` / `ctx.get("approval")` 只在
`ctx.fs.sandboxMode !== undefined` 时才读。Pi 的裸 `PiFsService` 的 `sandboxMode`
返回 `undefined`，故 Phase 1 **不必实现**这两个。

## ctx.fs 契约（FileSystem 抽象类）

```ts
abstract class FileSystem extends Service {
  constructor(ctx) { super(ctx, "fs"); }        // 自动注册为 ctx.fs
  get sandboxMode(): SandboxMode | undefined;    // 裸后端返回 undefined

  abstract resolve(path, { cwd?, signal? }): Promise<FsTarget>;
  abstract processPath(target): string;
  abstract fileUrl(target): string;
  abstract contains(parent, child): boolean;
  abstract stat(target, signal?): Promise<FsInfo | undefined>;
  abstract lstat(path, { cwd? }, signal?): Promise<FsPathInfo | undefined>;
  abstract readText(target, signal?): Promise<string>;
  abstract streamText(target, signal?): Promise<AsyncIterable<string>>;
  abstract listDir(target, signal?): Promise<FsDirEntry[]>;
  abstract writeText(target, content, expected?, signal?, sandboxPolicy?): Promise<FsWriteOutcome>;
  abstract editText(target, edit, expected?, signal?, sandboxPolicy?): Promise<FsEditOutcome>;
}
```

关键类型（`@deepseek-ai/dsh-fs/lib/types/types.d.ts`）：

```ts
interface FsTarget { targetKey: FsTargetKey; displayPath: string }  // targetKey 是 opaque
interface FsInfo { version: FsVersion; type: 'file'|'directory'|'other'; size?: number }
type FsWriteIntent = { kind:'createIfAbsent' } | { kind:'replaceIfVersion'; version }
interface FsWriteOutcome { operation:'create'|'update'; version; before: string|null; after: string }
interface FsEditRequest { oldString; newString; replaceAll: boolean }
interface FsEditOutcome { version; before: string; after: string }
class FsError extends HarnessError { code: FsErrorCode }  // 12 个稳定码
```

注意：
- `FsTargetKey(v)` / `FsVersion(v)` 运行时是**恒等函数**（brand 只在编译期），
  Pi 实现可直接传 string。
- `resolve` 的 `opts.cwd` 缺省时，dsh-tool-fs 走 `exec.agent?.session.header.cwd`，
  无 agent 时由后端用 `process.cwd()` 兜底。
- `writeText/editText` 的 `expected`（意图守卫）与 `sandboxPolicy` 是可选参数，
  裸后端（不沙箱）可直接忽略 `sandboxPolicy`。

## Pi 能力映射（compatibility.md 详表）

Pi 的 `PiFsService extends FileSystem` 就是「能力映射」的最小验证——用
`node:fs` 直连本地，未来替换成 `lib/file-access.ts` 的允许根校验 + 原子写。

其余能力同一模式：
- `PiLlmService`（→ models.json + ModelRegistry）
- `PiSessionService`（→ AgentSession / .jsonl）
- `PiTerminalService`（→ 内置终端 runtime）
- `PiBrowserService`（→ Semantic Browser V2 桥）
- `PiGitService`（→ git-status / git-changes）
