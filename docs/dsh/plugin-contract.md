# DSH 插件契约（Plugin Contract）

来源：`@deepseek-ai/cordis@4.0.1` 的 `src/registry.ts`（`Plugin` / `Plugin.Base` /
`RegistryService`）。

## 入口三形态

一个 DSH 插件是三种形状之一：

```ts
type Plugin<T> =
  | Plugin.Function<T>     // (ctx, config) => any
  | Plugin.Constructor<T>  // new (ctx, config) => any
  | Plugin.Object<T>       // { apply(ctx, config) => any }
```

`RegistryService.resolve()` 归一化：函数/class 直接用 `typeof === "function"`；
对象则取 `.apply`。所以：

```js
// function 插件
export default function myPlugin(ctx, config) { ... }

// object 插件
export default { name: "x", inject: ["fs"], apply(ctx, config) { ... } }
```

## 元数据（Plugin.Base）

```ts
interface Base<T> {
  name?: string;                    // 展示名，用于 fiber 诊断 + logger 名
  Config?: StandardSchemaV1<any, T> // 配置校验 schema（schemastery）
  inject?: Inject;                  // 依赖的服务：string[] 或 { name: interceptConfig }
  provide?: string | string[];      // 本插件提供的服务名
  intercept?: Dict<boolean>;        // 声明消费哪些服务的 intercept 配置
}
```

- `inject` 是**依赖注入声明**：只有列出的服务全部可用，插件才会加载（服务可用性驱动）。
- `Config` 是 schemastery schema（实现了 StandardSchemaV1），`apply` 收到的 `config`
  是**已经过 schema 校验+默认值填充**的结果，不是原始用户输入。
- `provide` 声明本插件往 ctx 上提供哪些服务名（供 loader / Service 读取）。

## 依赖注入入口

`@Inject(name, config?)` 装饰器可声明类/方法依赖；运行时等价于
`ctx.inject(deps, callback)` / `ctx.plugin({ inject, apply })`。

## 生命周期（Fiber）

每个 `ctx.plugin(plugin, config)` 调用产生一个 **Fiber**（插件的一次挂载）：

```
PENDING  → 等待 inject 声明的服务可用
LOADING  → 正在运行 plugin callback（apply）
ACTIVE   → 已加载，正在提供其 provide 的服务
FAILED   → callback 或配置校验抛错
DISPOSED → 被卸载（dispose）
```

关键语义：

- `ctx.plugin(...)` 返回 `Fiber & PromiseLike<Fiber>`，**await 它才完成加载**。
- `apply()` 里通过 `ctx.effect(() => disposer)` 或直接 `ctx.reflect.provide` 注册的
  资源，在 fiber dispose 时按**逆序**自动释放。
- class 插件：`new Class(ctx, config)`，实例生命周期绑定 fiber。
- function 插件：`fn(ctx, config)`。

## 与 Pi Studio 适配器的关系

Pi 的 `dsh-adapter` 会把一个真实 DSH 插件包导入，得到上述入口之一，然后：

```ts
await ctx.plugin({ name, inject, apply, Config }, rawConfig);
```

其余（服务注入、fiber 管理、依赖解析）全部交给真 Cordis——**Pi 不重写运行时**。
