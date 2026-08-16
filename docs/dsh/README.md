# DSH Compatibility Specification

这是 Pi Studio 对 **DeepSeek Harness (DSH) 插件协议** 的实证契约规格。它不是设计文档，
而是「DSH 是什么」的事实固化——全部内容来自对真实 npm 包的源码逆向，**不是猜测**。

## 核心结论（已被 POC 证明）

> **Pi Studio 不需要模拟 DSH，也不需要启动 DSH。它可以直接承载真实 DSH Plugin。**

实现路径不是「造一个假的 DSH ctx」，而是：

```
@deepseek-ai/cordis（真实运行时，直接 npm i）
        ↓
new Context()
        ↓
Pi 能力写成 extends Service 的适配器
        ↓
ctx.reflect.provide("fs" | "tools" | "systemPrompt" | "skills", …)
        ↓
加载真实 @deepseek-ai/dsh-tool-fs
        ↓
plugin(ctx, config) → ctx.tools 注册 read / write / edit
        ↓
Pi Studio Agent 可调用（读写 Pi 项目文件）
```

**POC 实测结果**（`@deepseek-ai/dsh-tool-fs` 脱离 DSH CLI，在真 Cordis + Pi 的 fs Service 上）：

```
[1] registered tools: ["read","write","edit"]
[2] read  => 带行号读取真实文件
[3] write => create 一个新文件（走 Pi 的 fs Service）
[4] edit  => 字面替换
[5] final => 磁盘上文件真的被改对了
[6] disposed ✔
```

POC 逻辑已固化在 `lib/plugins/adapters/dsh/dsh-runtime.ts`（`createDshRuntime` +
`loadPlugin`），桥接在 `dsh-tool-adapter.ts`。实测结果见 compatibility.md。

## 文档索引

| 文件 | 内容 |
| --- | --- |
| [plugin-contract.md](plugin-contract.md) | 插件入口三形态 + name/inject/provide/Config/intercept 元数据 + 生命周期 |
| [cordis-runtime.md](cordis-runtime.md) | Context（Proxy）/ Service / Registry / Fiber 运行时模型 |
| [patch-composition.md](patch-composition.md) | cordis.patch.yml 的 composition 格式与 profile composer 语义 |
| [services.md](services.md) | ctx 服务清单 + fs / tools / systemPrompt 契约 |
| [skills.md](skills.md) | ctx.skills 分层 SkillService + Provider 契约 |
| [tools.md](tools.md) | defineTool + ctx.tools.register 契约 |
| [compatibility.md](compatibility.md) | Pi 能力映射表 + 分阶段 + POC 证据 |

## 版本钉死

| 包 | 版本 |
| --- | --- |
| @deepseek-ai/dsh | 0.1.0-rc.6 |
| @deepseek-ai/cordis | 4.0.1 |
| @deepseek-ai/dsh-base | 0.0.1-rc.1 |
| @deepseek-ai/dsh-tool-fs | 0.0.1-rc.1 |
| @deepseek-ai/dsh-skill | 0.0.1-rc.1 |
| @deepseek-ai/dsh-fs | 0.0.1-rc.1 |
| @deepseek-ai/dsh-tools | 0.0.1-rc.1 |
| @deepseek-ai/dsh-system-prompt | 0.0.1-rc.1 |

DSH 是 developer preview，**契约会变**。升级时重新 dump 上述包，diff
`lib/plugins/adapters/dsh/dsh-contract.ts`（它导出 `dshContractFingerprint()`）。

## 如何重新 dump（复现逆向）

```bash
NPM="node $(node -e "console.log(require.resolve('npm/bin/npm-cli.js'))")"
mkdir -p /tmp/dsh-dump && cd /tmp/dsh-dump
for p in "@deepseek-ai/dsh@0.1.0-rc.6" "@deepseek-ai/cordis@4.0.1" \
         "@deepseek-ai/dsh-base" "@deepseek-ai/dsh-skill" "@deepseek-ai/dsh-tool-fs" \
         "@deepseek-ai/dsh-fs" "@deepseek-ai/dsh-tools" "@deepseek-ai/dsh-system-prompt" \
         "@deepseek-ai/cordis-plugin-loader"; do
  $NPM pack "$p"
done
# 逐个 tar -xzf，读 package/src/*.ts（cordis 带源码）与各包 lib/index.js + lib/types/*.d.ts
```

## 关键实现约定（写适配器时遵守）

1. **依赖真 Cordis，不 shim**：`import { Context, Service } from "@deepseek-ai/cordis"`。
2. **Pi 能力 = Service 适配器**：每个能力写一个 `extends Service` 的类，
   `super(ctx, "fs")` 自动注册为 `ctx.fs`，未来 PiFsService / PiGitService /
   PiSessionService / PiTerminalService / PiBrowserService / PiLlmService 同一模式。
3. **插件加载是服务可用性驱动**：插件声明 `inject:["fs"]`，只有 `ctx.fs` 被 provide 后
   它才 apply。所以「能加载」=「依赖的 Pi 能力已就位」。
4. **加载单元是 composition（cordis.patch.yml）**，不是 package.json manifest。
5. **ds-contract.ts 是唯一事实来源**，适配器、市场、升级检测都读它。
