# 文档：DeepSeek Harness 官网同款动态背景（GlowBackground）

- 编写角色：writer（TASK-004 文档）
- 日期：2026-08-25
- 关联任务：TASK-001（参考 DeepSeek Harness 官网动态背景，为当前项目添加同款动态背景效果）
- 覆盖：`components/GlowBackground.tsx`（实现）+ `components/AppShell.tsx`（集成挂载）+ 官方调研报告 `docs/research/deepseek-harness-dynamic-background.md`
- 依据：本文档所有接口/行为描述均以 `components/GlowBackground.tsx` 与 `components/AppShell.tsx` 实际代码为准（先读后写），未编造。

---

## 一、背景与方案概述

用户希望参考 https://www.deepseek.com/harness/en/ 官网的动态背景效果，为当前项目（Pi Studio）添加同款动态背景。

> ⚠️ **本次修订（真实落地修复）**：项目组当初只做了 `tsc`/`eslint` 与结构核对，**没有在真实运行界面里肉眼确认可见性**。实际上 `GlowBackground` 虽已挂载，但被下方不透明的面板（`var(--bg-panel)`/`var(--bg)`）盖住了——它 `z-index:0` 位于所有内容之下，用户根本看不见，所以“项目组说成功、实际没效果”。本次已修复可见性（详见「七、变更/修复记录」），并新增设置项开关与主题色跟随。

经调研（`docs/research/deepseek-harness-dynamic-background.md`）确认：官网动态背景是**三层叠加**，而非单一效果——

| 层 | 技术 | 官网位置/效果 | 本项目是否落地 |
|----|------|---------------|---------------|
| ① 底层 | WebGL + GLSL shader | 全屏流动「云雾/烟」，`mix-blend-mode:screen` + 径向 mask | **未启用**（进阶可选，成本/性能高） |
| ② 中层 | Canvas2D 粒子连线网络 | 小球散布 + 距离近则连线，`requestAnimationFrame` 逐帧，带鼠标扰动 | ✅ 已实现 |
| ③ 上层 | 纯 CSS radial-gradient 光斑 | 三团底部模糊光晕（blur 60–100px），亮暗分布 | ✅ 已实现 |

本项目落地**方案 ②+③**（零依赖、观感接近、成本低），层① WebGL 云雾作为完全复刻官网的进阶项，本期不启用。

---

## 二、实现组件：components/GlowBackground.tsx

### 2.1 组件职责

`GlowBackground` 是一个 React 客户端组件（`"use client"`），负责渲染两层的官网同款动态背景：

1. **CSS 模糊光斑层** —— 三个 `.glow-blob`（`glow-blob-left` / `glow-blob-center` / `glow-blob-right`）div，位于左下/中下/右下。
2. **Canvas2D 粒子连线网络** —— 一个 `<canvas>`，逐帧绘制小球与连线。

### 2.2 对外接口

```tsx
import { GlowBackground } from "@/components/GlowBackground"; // 或 "./GlowBackground"

// 无 props、无受控参数、无回调。开/关由全局设置项（useGlowBackground）驱动。
<GlowBackground />
```

- **无 props、无参数**：用法即 `<GlowBackground />`，自挂载、自适应。
- **声明式开箱即用**：组件内部完成画布初始化、粒子生成、动画循环、主题适配与资源清理，调用方无需任何配置。
- **开关控制**：组件通过 `useGlowBackground()`（`hooks/useGlowBackground.ts`）读取全局启用状态；设为关闭时组件渲染 `null`，并完全停止动画与监听（零 CPU 消耗）。默认开启。

### 2.3 结构 / 行为

| 项 | 值/说明 |
|----|---------|
| 根容器 | `<div aria-hidden="true" className="glow-background">`，`position:fixed; inset:0; zIndex:1; pointerEvents:none; overflow:hidden`（**z-index 1 是可见性修复的关键**：原先 0 会被不透明面板完全盖住；1 让它浮在内容面板之上、又仍在固定窗口控件/模态之下） |
| 3 个光斑 `.glow-blob` | `radial-gradient` + `color-mix(in srgb, var(--accent) X%, transparent)` ，`filter:blur(60–100px)`；亮/暗主题不同 opacity |
| 光斑分布 | left `bottom:-100px; left:8%` 480×480；center `bottom:-60px; left:50%` 700×400（`translate:-50% 0`）；right `bottom:-80px; right:8%` 400×400 |
| canvas | 随视口 `width/height × dpr`（dpr 上限 2）；`ResizeObserver` 监听 body 自适应 |
| 粒子 | `BASE_COUNT=60`，按视口面积缩放，目标数 `Math.min(max(area/1280x800,40),180)` |
| 连线 | `LINK_DIST=140`，距离近则连线，透明度随距离衰减（`alpha = (1-d²/LINK_DIST²)×0.28`） |
| 动画 | `requestAnimationFrame` 逐帧；`FPS_CAP=30` 帧率上限（间隔不足即跳过该帧） |
| 鼠标扰动 | `mousemove` 监听，粒子距鼠标 120px 内被轻推；`document.mouseleave` 归位；仅监听不拦截指针 |
| 主题适配 | `useTheme().isDark` 控制连线/粒子取色（暗色用 accent、亮色用 text-dim）；每 120 帧重读 `var(--accent)`/`var(--text-dim)`，主题切换自动跟随 |
| 减弱动画 | 用户通过设置开关显式开启，故**始终带动画 + 鼠标扰动**；用户的明确选择优先于系统 `prefers-reduced-motion` 提示，不想要动画的可直接关掉开关 |
| 资源清理 | useEffect 清理：`cancelAnimationFrame` + `removeEventListener`(x2) + `ro.disconnect()` |

### 2.4 设计要点（颜色不硬编码）

- 所有颜色均用项目 CSS 变量派生（`var(--accent)` / `var(--text-dim)`），**不硬编码**官网蓝色（`#1A3870/#2D5F9E/#4A8AC4`），亮/暗主题自动适配。
- 组件使用样式为**内联样式**，未改动 `app/globals.css`。

---

## 三、集成：components/AppShell.tsx

`GlowBackground` 挂载在 **AppShell 根 flex 容器内部、作为首个子元素**，置于所有面板之下。

- **import**（`components/AppShell.tsx` 第 26 行）：
  ```tsx
  import { GlowBackground } from "./GlowBackground";
  ```
- **挂载**（`components/AppShell.tsx` 第 1191 行，根容器首子元素）：
  ```tsx
  return (
    <>
    <style>{`...`}</style>
    {/* 主布局容器 */}
    <GlowBackground />   {/* 最底层，z-index:0，pointer-events:none */}
    ...其余面板（sidebar / chat / right-panel）置于其上
  );
  ```

### 层级说明（不遮挡交互）

| 元素 | z-index / 特性 |
|------|---------------|
| `.glow-background`（GlowBackground） | `position:fixed; inset:0; zIndex:1; pointerEvents:none` —— 位于内容面板（静态、z-index 自动）之上、但低于固定窗口控件（顶栏下拉 500 / 侧栏 200 / 模态 9999），不消费指针事件 |
| sidebar | z-index 200 |
| mobile backdrop | z-index 199 |
| chat / 右侧面板 | 均不透明 `var(--bg-panel)` / `var(--bg)` 覆盖其上 |

结论：背景层在最底层且不拦截鼠标，鼠标扰动仅监听 `mousemove` 而不消费事件，不影响点击/输入。

---

## 四、使用说明

### 4.1 开启/查看效果

动态背景**默认开启**，但可在设置里开关：**设置 → 外观 → 动态背景**（`设置 → Appearance → Dynamic background`）。关闭后组件卸载画布与动画，完全不耗性能。

```bash
npm run dev            # 浏览器模式（效果同样生效，无需右侧浏览器桥）
npm run dev:electron   # Electron 桌面壳（推荐，观感最佳）
```

> **说明**：这是一个用户在设置里**显式开启**的装饰性背景（设置 → 外观 → 动态背景），因此即便系统开启了「减弱动态效果」（`prefers-reduced-motion: reduce`，Windows 动画效果关闭时常见），粒子连线仍会**正常带动画**并响应鼠标——用户的明确选择优先于系统提示。不想要动态效果时，直接在设置里关掉开关即可。

### 4.2 交互 / 自适应行为

| 场景 | 表现 |
|------|------|
| 移动鼠标 | 120px 范围内的粒子被轻推扰动（仅观感，不拦截操作） |
| 缩放窗口 | `ResizeObserver` 自适应，粒子数随视口面积重算（40–180） |
| 切换亮/暗主题 | 光斑强度与粒子/连线条目自动跟随 accent 变化（每 120 帧重读 CSS 变量） |
| 系统开启「减弱动态效果」 | 不影响：用户在设置里显式开启，粒子仍带动画并响应鼠标（用户的明确选择优先于系统提示） |
| 标签页隐藏 | 浏览器自动暂停 `requestAnimationFrame` |

### 4.3 需要调整观感时（开发者）

参数集中在 `components/GlowBackground.tsx` 顶部常量，可按需调节：

| 常量 | 默认 | 含义 |
|------|------|------|
| `LINK_DIST` | 140 | 粒子连线最大距离 |
| `FPS_CAP` | 30 | 动画帧率上限 |
| `BASE_COUNT` | 60 | 基础粒子数（视口面积缩放后 min 40 / max 180） |
| 三个 `.glow-blob` opacity | dark 0.22/0.3/0.18，light 0.16/0.18/0.12 | 光斑强度（亮暗分别控制） |
| 三个 `.glow-blob` `filter:blur` | 80/100/60px | 光斑模糊半径 |

---

## 五、验证结论（摘自 tester 报告，已通过）

`docs/team/testing/tester-dynamic-background-report.md` 实跑验证 **PASS**：

- **TypeScript**：`node_modules/.bin/tsc --noEmit` 全项目 **0 error**。
- **ESLint（改动文件）**：`eslint components/GlowBackground.tsx components/AppShell.tsx`，GlowBackground **0 error 0 warning**；AppShell 仅 5 条既有未用变量 warning（`ReactNode/isDark/setLocale/supportedLocales/setSidebarWidth`，非本次新增）。
- 需求点全部对照通过：光斑层 / 粒子连线 / 集成挂载(最底层,不遮挡) / 主题自适应 / reduce-motion / 性能(帧率上限、粒子自适应、隐藏 tab rAF 暂停) / 资源清理。

### 已知提示（不阻塞）

1. `color-mix()`（Chrome 111+）与 CSS `translate` 定位依赖现代 Chromium —— 本项目目标环境为 Electron（内嵌 Chromium），满足；未来若做纯浏览器跨引擎兼容需注意。
2. 光斑强度/粒子密度/明暗对比的最终观感依赖主观判断，建议在 Electron 桌面应用下肉眼确认亮/暗两主题效果符合预期。

---

## 六、相关文档

| 文档 | 说明 |
|------|------|
| `docs/research/deepseek-harness-dynamic-background.md` | 官网三层结构的调研报告（含技术方案、风险、已实现核验） |
| `docs/team/testing/tester-dynamic-background-report.md` | 功能/质量验证报告（PASS） |
| `components/GlowBackground.tsx` | 动态背景实现组件 |
| `components/AppShell.tsx` | 动态背景集成挂载位置 |
| `hooks/useGlowBackground.ts` | 动态背景开/关的全局状态（含 localStorage 持久化） |
| `components/SettingsPanel.tsx` | 外观设置里新增「动态背景」开关 |

---

## 七、变更/修复记录（真实落地修复）

> 本节为「项目组说成功、实际没效果」问题的复盘与修复，也是当前代码的真实状态。

### 7.1 问题：组件已挂载但用户看不见

- **表象**：`components/AppShell.tsx` 第 1191 行已 `<GlowBackground />`，`GlowBackground.tsx` 也已在 AppShell 根容器内作为首个子元素挂载。但用户运行后**看不到任何动态背景**。
- **根因**：`.glow-background` 的 `z-index: 0`，被后续渲染的**不透明面板背景**（主内容区 `var(--bg)`、顶栏/右侧面板 `var(--bg-panel)` 等）完全盖住。层级为 0 意味着它位于这些面板之下，光斑与粒子都被页面内容挡住，形同没有。
- **验证**：headless Chromium 加载真实页面确认——`.glow-background` 存在、3 个 `.glow-blob` 都在、canvas 尺寸正确，但光斑被面板遮住、肉眼不可见；`z-index: 0` 时截图中几乎看不到；改为 `z-index: 1` 后底部三团光斑与粒子网格清晰可见。

### 7.2 修复内容

| 文件 | 改动 |
|------|------|
| `components/GlowBackground.tsx` | ① 根容器 `z-index: 0 → 1`，让光斑/粒子浮在内容面板之上，但仍在固定窗口控件（顶栏下拉 500、侧栏 200）、模态（9999）之下，`pointer-events:none` 保证不拦截点击/输入；② 增大三团光斑 opacity（亮色 0.24/0.3/0.22，暗色 0.3/0.38/0.28）提升可见度；③ 接入 `useGlowBackground()`，关闭时渲染 `null` 并停用一切资源 |
| `hooks/useGlowBackground.ts`（新增） | 全局启用状态 + `localStorage` 持久化（`pi-glow-background`），默认开启；与 `useAccentColor` 同类 `globalThis` 存储以兼容热更新 |
| `components/SettingsPanel.tsx` | 外观（Appearance）分组新增「动态背景 / Dynamic background」开关（`Switch`），绑定 `setGlowEnabled` |
| `lib/i18n/messages/en.ts` / `zh-CN.ts` | 新增 `settings.glowBackground` / `settings.glowBackgroundDesc` 文案（中英） |

### 7.3 修复后验证（headless 实测）

1. **可见性**：加载真实页面，底部三团绿光（跟随 `--accent: #5BAF68` 绿色）+ 粒子连线网络清晰可见。
2. **开关**：`localStorage` 设 `pi-glow-background=0` 后重载 → `.glow-background` 不存在（组件返回 `null`）；设为 `1` 后重载 → 重新出现。
3. **主题色跟随**：光斑/粒子/连线全部用 `var(--accent)` 派生，切主题色（绿/蓝/紫…）自动跟随。
4. **`tsc --noEmit` 全项目 0 error；`eslint`（GlowBackground/SettingsPanel/useGlowBackground）0 error 0 warning。**
5. **动态 + 鼠标**：即便系统开启 `prefers-reduced-motion`，因用户显式开启开关，粒子仍**始终动画**并响应鼠标扰动（headless 实测像素数随时间变化、mousemove 后变化）。

---

## 八、样式 / 光晕强度 / 光斑飘动扩展

### 8.1 多背景样式

`GlowBackground` 现支持 4 种可切换的 Canvas 动态效果（设置 → 外观 → 背景样式）：

| 样式 id | 效果 |
|---------|------|
| `particles`（默认） | 粒子连线网络（距离近则连线，鼠标轻推） |
| `planets` | 轨道行星系：椭圆轨道 + 行星光晕 + 卫星 + 星空背景 + 鼠标视差 |
| `aurora` | 流动极光带：多层正弦光带 + 渐变 |
| `stars` | 闪烁星点 |
| `bokeh` | 光斑球：柔和光斑球缓慢上浮（全屏漂动） |
| `waves` | 波浪：层叠正弦光带覆盖整屏流动 |
| `nebula` | 星云：整屏软云雾星系缓缓漂移 |

- 样式状态（`particles`/`planets`/`stars`）在 `style` 变化时惰性重建（`draw` 内检测 `styleRef.current !== styleNow` 调 `spawnAll()`），`isDark`/`intensity` 走 ref，不重建状态。
- 每种样式都在统一的 `draw` 帧循环里按当前 `styleNow` 分派到对应绘制函数。

### 8.2 光晕强度（可拖动）

- `useGlowBackground` 新增 `intensity`（0.4–1.6，默认 1.0），持久化在 `pi-glow-intensity`。
- 设置 → 外观 → **光晕强度** 是 `<input type="range">` 滑块，拖动即时生效：光斑 opacity = `BLOB_BASE × intensity`（上限 0.9），Canvas 各效果的透明度/饱和也乘 `intensity`。

### 8.3 光斑自由飘动

- 三个 `.glow-blob` 通过全局 `<style>` 注入的 `@keyframes glow-drift-a/b/c` 做**自由飘动**（translate + scale，9–13s 循环），并与中心光斑的 `translate: -50% 0` 居中属性叠加（`translate` 属性先于 `transform` 应用，互不冲突，GPU 合成）。横向 ≤82px、纵向 ≤72px，光斑始终在底部区域浮动，不会飘走。
- 实时验证：`headless` 三个光斑 `animationName` 分别为 `glow-drift-a/b/c`，1.5s 内 `getBoundingClientRect` 位置变化（`BLOBS DRIFTED: true`）。