# cordis.patch.yml — 插件组合（Composition）

来源：`@deepseek-ai/dsh-base@0.0.1-rc.1/cordis.patch.yml`（60+ 行真实样本）+
`@deepseek-ai/cordis-plugin-loader@1.0.2`（profile composer）。

## 关键事实

**DSH 插件的加载单元不是 package.json manifest，而是 composition 文件。**

`@deepseek-ai/dsh-base` 这个包**没有任何运行时代码**（`index.d.ts` 就一句
`export {}`）。它的实体是一个 `cordis.patch.yml`，由 package.json 的
`dsh.bundle.patch` 字段声明：

```json
{
  "name": "@deepseek-ai/dsh-base",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

## 格式

```yaml
# 一个 insert 块 = 新增一批插件行
- insert:
    - id: llm              # composition 内稳定引用 id
      name: '@deepseek-ai/dsh-llm'   # npm 包名
      config: { ... }       # 可选，传给 apply 的原始配置
    - id: tool-fs
      name: '@deepseek-ai/dsh-tool-fs'
    - id: skill-badge
      name: '@deepseek-ai/dsh-skill-badge'
      disabled: true        # 禁用该行

# 顶层行 = 覆盖已有行（last write wins per row）
- id: bash-sandbox
  disabled: true
```

## 语义

1. **后写覆盖先写**：不同 layer 的 patch 按顺序应用，同一 `id` 最后写者生效。
   （dsh-base 是「empty root 上的一个 insert」；之后 bundle layer + 用户 profile
   patch 按 id 覆盖。）
2. **行顺序无加载语义**：激活是**服务可用性驱动**的——一个插件只有它的
   `inject` 服务全部可用才加载，跟行在 yaml 里的位置无关。
3. **`name` 是 npm 包名**，profile composer 按它 `require` 插件入口，再按
   `inject`/`provide` 建依赖图。
4. **平台层**：Windows 有 `windows.cordis.patch.yml`，在 bundle 与用户层之间应用
   （bash-sandbox 换成 pwsh-sandbox，因为二者都注册同名 `bash` 服务，**重复挂载
   会在 load 时 fail loud**）。

## 对 Pi 适配器的意义

Pi 的 `dsh-manifest.ts` 读包的 `dsh.bundle.patch` → 解析 cordis.patch.yml →
拿到该包提供的插件行（id + name + config）。Pi 不需要实现 profile composer，
只需要：
- 读单个包的 patch，得到「这个包引入了哪些插件行」；
- 把每行的 `name` 包导入 + `ctx.plugin(entry, config)` 挂载。

组合冲突（同名服务重复挂载）由真 Cordis 的 `provide` 重复检测兜底。
