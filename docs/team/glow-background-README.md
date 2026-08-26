# 动态背景效果使用说明（DeepSeek Harness 官网同款）

> 面向使用者的 README：回答「怎么给项目添加这种动态背景效果」。
> 技术实现细节见 `docs/team/glow-background-implementation.md`，官网调研见 `docs/research/deepseek-harness-dynamic-background.md`。

- 编写角色：writer
- 日期：2026-08-25
- 对应文件：`components/GlowBackground.tsx`（实现）+ `components/AppShell.tsx`（集成挂载，第 1191 行）

---

## 一、这是什么

Pi Studio 已加入与 DeepSeek Harness 官网同款风格的**动态背景**——由两部分组成：

1. **可自由飘动的三团模糊光斑**（左下 / 中下 / 右下，`radial-gradient` + `blur`，会缓慢漂浮移动，强度可调）；
2. **可切换的动态效果层**（Canvas2D，鼠标移过会轻推 / 产生视差）：
   - **粒子**（默认）：小球散布，距离近则自动连线；
   - **行星**：轨道行星系 + 光晕 + 星空 + 鼠标视差；
   - **极光**：流动的彩色极光带；
   - **星空**：闪烁的星点；
   - **光斑球**：柔和光斑球在整个屏幕缓慢上浮（全屏漂动）；
   - **波浪**：层叠波浪光带覆盖整屏流动；
   - **星云**：整屏软云雾星系缓缓漂移。

效果自动适配亮 / 暗主题，颜色跟着项目主题色（`--accent`）走，不硬编码官网的蓝色。

### 外观里可调的东西

| 项 | 说明 |
|----|------|
| **动态背景** | 总开关（开 / 关） |
| **背景样式** | 粒子 / 行星 / 极光 / 星空 / 光斑球 / 波浪 / 星云，点选即切换（后三种为整屏漂动效果） |
| **光晕强度** | 拖动滑块，增强 / 减弱光晕与动态效果的浓度 |

---

## 二、默认开启，可在设置里开关

组件已在 `AppShell.tsx` 根容器里挂载为最底层，**默认开启**。可在**设置 → 外观 → 动态背景**（Settings → Appearance → Dynamic background）随时开关；关闭后组件会卸载画布与动画，完全不耗性能。

```bash
npm run dev            # 浏览器模式（效果同样生效）
npm run dev:electron   # Electron 桌面壳（推荐观感最佳）
```

`npm run pack:dir` / 打包后的 exe 同样生效。

### 怎么确认生效
启动后盯着界面**底部**看：应该能同时看到三团带主题色（默认绿）色调的模糊光晕，以及缓慢流动、鼠标移过会被推开的细小粒子网点。这就是官网同款背景。

> **关于动态效果**：这是你在设置里**显式开启**的装饰性背景，因此即便系统开启了「减弱动态效果」（Windows 关闭动画效果时常见，`prefers-reduced-motion: reduce`），粒子连线仍会**正常带动画**并响应鼠标。不想要动态效果时，直接在设置里关掉「动态背景」开关即可。

---

## 三、会自动做什么（无需操心）

| 场景 | 表现 |
|------|------|
| 移动鼠标 | 120px 范围内的粒子会被轻轻推开（只影响观感，不拦截点击/输入） |
| 缩放/拉伸窗口 | 背景通过 `ResizeObserver` 自适应，粒子数量按视口面积自动增减 |
| 切换亮 / 暗主题 | 光斑强度与粒子/连线颜色自动跟随主题色变化 |
| 系统开启「减弱动态效果」 | 不影响：用户在设置里显式开启，粒子仍带动画并响应鼠标 |
| 切换/隐藏标签页 | 浏览器自动暂停 `requestAnimationFrame`，不耗电 |
| 设置里关闭 | 完全卸载（组件返回 `null`），零开销 |

---

## 四、想微调观感（开发人员）

所有参数集中在 `components/GlowBackground.tsx` **顶部常量**，按需修改即可：

| 常量 | 默认 | 含义 |
|------|------|------|
| `LINK_DIST` | 140 | 粒子连线的最大距离（越大连线越密） |
| `FPS_CAP` | 30 | 动画帧率上限（已足够顺滑，兼顾性能） |
| `BASE_COUNT` | 60 | 基础粒子数（再按视口面积缩放，下限 40 / 上限 180） |
| 三个 `.glow-blob` 的 `opacity` | 暗色 0.3/0.38/0.28，亮色 0.24/0.3/0.22 | 光斑强度 |
| 三个 `.glow-blob` 的 `filter:blur` | 80 / 100 / 60 px | 光斑模糊半径（越大就越扩散） |

> 建议：粒子 `COUNT` / 连线 `LINK_DIST` 调低一点更「克制」，调高更「热闹」；光斑 `opacity` 调高会更吸睛但也可能抢内容，按观感取舍。

---

## 五、原理简版（为什么这么做）

官网动态背景其实是**三层叠加**，不是单一一层：

| 层 | 技术 | 本项目是否落地 |
|----|------|---------------|
| 底层 | WebGL + GLSL shader 流动云雾（`mix-blend-mode:screen` + 径向 mask） | **未启用**（进阶可选，成本/性能高） |
| 中层 | Canvas2D 粒子连线网络（`requestAnimationFrame` 逐帧） | ✅ 已实现 |
| 上层 | 纯 CSS `radial-gradient` 光斑（`blur`） | ✅ 已实现 |

**本项目采用「中层 + 上层」**：零依赖、观感接近官网、成本低。官网的「流动云雾」（GLSL）作为完全复刻的进阶项，本期做权衡取舍**未启用**——如果你想要那层云雾，可依调研报告 `docs/research/deepseek-harness-dynamic-background.md` 中的 shader 配方法补上（`noiseBoost/swirlBoost/glowIntensity` + `u_time` + 三色辉光），属可选增强，不是 bug。

---

## 六、关于兼容性

- 组件使用了 `color-mix()`（Chrome 111+）与 CSS `translate` 定位属性，**依赖现代 Chromium**。
- 本应用目标环境为 Electron（内嵌 Chromium），**满足要求**；若未来做纯浏览器跨引擎兼容需注意这一前提。

---

## 七、相关文档

| 文档 | 内容 |
|------|------|
| `docs/team/glow-background-implementation.md` | 实现组件 + 集成的完整技术文档（接口、结构、参数、层级） |
| `docs/research/deepseek-harness-dynamic-background.md` | 官网三层结构调研报告（含 GLSL shader 配方与风险） |
| `hooks/useGlowBackground.ts` | 动态背景开/关的全局状态（设置项核心，localStorage 持久化） |
| `components/GlowBackground.tsx` | 动态背景实现组件 |
| `components/AppShell.tsx` | 动态背景集成挂载位置（第 1191 行） |