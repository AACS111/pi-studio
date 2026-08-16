# Cordis 运行时模型

来源：`@deepseek-ai/cordis@4.0.1` 的 `src/context.ts` / `src/service.ts` /
`src/registry.ts` / `src/events.ts` / `src/fiber.ts`。

## Context（Proxy + 服务解析器）

`Context` 是一个 **Proxy**：普通属性读取走服务解析器，`ctx.fs` 实际解析到名为
`fs` 的 Service 实例。核心结构：

```ts
interface Context {
  root: this;          // 根 context（所有子 context 共享）
  baseUrl?: string;    // 相对插件/模块 specifier 的解析基准
  events: EventsService;   // 事件总线
  logger: LoggerService;   // ctx.logger(name) 取命名 logger
  reflect: ReflectService; // ctx.get / ctx.provide 反射层
  registry: RegistryService; // ctx.plugin / ctx.inject 插件注册表
}
```

混入到 `ctx` 上的方法：
- 事件：`ctx.on` / `ctx.once` / `ctx.emit` / `ctx.parallel` / `ctx.serial` / `ctx.bail` / `ctx.waterfall`
- 注册：`ctx.plugin` / `ctx.inject`
- 反射：`ctx.get(name)` / `ctx.provide(name, value)`

## Service（能力注入点）

Pi 的能力适配器就是 `Service` 子类：

```ts
class PiFsService extends FileSystem {
  constructor(ctx) { super(ctx, "fs"); } // 自动注册为 ctx.fs
}
```

`Service` 构造器 `super(ctx, name)` 调用 `ctx.reflect.provide(name, this, check)`，
**自动注册**并在 owning fiber 卸载时**自动移除**。服务名缺省取静态 `provide` 字段。

## Registry（插件加载）

`ctx.plugin(plugin, config)`：
1. `resolve()` 归一化三形态 → callback
2. 按 callback 复用/创建 runtime（`{ name, callback, fibers, Config }`）
3. 创建 Fiber，用 `Inject.resolve(plugin.inject)` 声明依赖
4. 服务齐了 → 调用 callback（class 用 `new`，否则直接调用）
5. 返回 `Fiber & PromiseLike<Fiber>`

## Fiber（作用域 + 生命周期）

`ctx.extend(meta)` / `ctx.isolate(name, label)` / `ctx.intercept(name, config)`
创建**作用域化子 context**：子 context 原型继承父的所有属性，不反向污染父。

这对 Pi 的意义：一个 DSH 插件加载在某个 scope 下，它 `provide` 的服务只在该
scope 可见；dispose 该 scope 的 fiber 即整体卸载，不会泄漏到别的会话。

## 事件（EventsService）

`waterfall` 是带 `next` 续延的合成派发（`ctx.waterfall("fs/write-intent", ...)`），
dsh-tool-fs 用它做「单槽决策」；`emit` 同步不等待（`ctx.emit("fs/observed", ...)`）。
这些都由真 Cordis 提供，Pi 不需要自己实现。
