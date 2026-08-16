# DSH Skill 契约（ctx.skills）

来源：`@deepseek-ai/dsh-skill@0.0.1-rc.1/lib/types/index.d.ts`。

## 模型：分层 Service + Provider，不是「扫 SKILL.md 目录」

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { skills: SkillService }
}

class SkillService extends Service {
  registerProvider(create: (control) => SkillProvider): () => void;  // 注册来源
  register(skill: SkillRegistration): () => void;                    // 注册运行时 skill
  list(options?): Promise<SkillSummary[]>;                           // 列概要
  snapshot(options?): Promise<SkillCatalogSnapshot>;
  get(name, options?): Promise<SkillDefinition | undefined>;         // 加载全文
}
```

## Provider 接口（一个 skill 来源）

```ts
interface SkillProvider {
  name: string;
  list(options: SkillLookupOptions): Promise<SkillCandidate[] | SkillProviderObservation>;
  get(candidate, options): Promise<SkillDefinition | undefined>;
}
```

- `list()` 里做远程初始化/认证/发现（**异步**），`registerProvider()` 本身同步。
- Pi 适配器：把 Pi 的 skill 目录注册成一个 `SkillProvider`，或反向把 DSH 的
  provider 转成 Pi 的 `DefaultResourceLoader` 源。

## 分层与优先级

- **scope 分层**：host 行 + 仓库插件进 global layer；agent preset 的 composition
  挂载进该 preset 的 layer。读 = global layer 合并 viewing scope 链，**最近的
  layer 同名直接赢**。
- **rank**：同一 layer 内 rank 小者赢（`BUNDLED_SKILL_RANK = 600`）。
- `SkillSource` 桶：`project-dsh | project-agents | runtime | user-dsh | user-agents | custom | bundled`。

## Skill 类型

```ts
interface SkillSummary {       // list() 返回的概要（不含正文）
  name: string;                // kebab-case
  description: string;
  whenToUse?: string;
  invocation: SkillInvocationPolicy;   // { modelInvocable, userInvocable }
  source: SkillSource;
  provider: string;
  resourceBase?: SkillResourceBase;     // directory | url | opaque
}
interface SkillDefinition extends SkillSummary {
  content: string;             // markdown 正文（已剥 frontmatter）
  path?: string;
  metadata?: Record<string, unknown>;
}
```

## 与 Pi 的差异（适配点）

| DSH | Pi | 适配 |
| --- | --- | --- |
| 分层 provider + rank | `DefaultResourceLoader` 扫目录 | DSH provider → Pi loader 源，或 Pi skill → DSH SkillProvider |
| `invocation.modelInvocable/userInvocable` | SKILL.md frontmatter `disable-model-invocation` | 双向映射 |
| `renderSkillContent()` 渲染 `<skill_content>` | pi 直接注入 markdown | 按需复用或替换 |

## Skill 目录布局（实证）

- 官方 preset：`config/agent-presets/<preset>/skills/<name>/SKILL.md`
- 插件包常见：`.dsh/skills/**/SKILL.md`

Phase 1 的 `dsh-skill-adapter.ts` 识别 `SKILL.md` + `scripts/` + `references/` +
`assets/`，转成 pi 的 skill 目录布局（复用 `/api/skills` + `skill-lock.ts`）。
