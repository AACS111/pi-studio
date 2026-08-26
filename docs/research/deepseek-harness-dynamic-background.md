# 调研报告：DeepSeek Harness 官网动态背景的技术实现与集成方案

- 调研角色：researcher
- 日期：2026-08-25
- 目标：分析 https://www.deepseek.com/harness/en/ 官网的动态背景效果，为 Pi Studio 项目集成同款动态背景提供可验证的技术方案
- 状态：结论 + 依据 + 风险（完整交付）

---

## 一、结论（TL;DR）

官网的动态背景是**三层叠加技术**，不是单一效果，也不是纯 CSS 能完全复现的：

| 层 | 技术 | 位置/效果 | 是否可在本项目复刻 |
|----|------|-----------|-------------------|
| ① 底层 | **WebGL + GLSL shader**（canvas） | 全屏流动「云雾/烟」：Perlin 噪声 + 时间 `u_time` + 三色辉光（glowColor1/2/3），`mix-blend-mode:screen`，`mask:radial-gradient(ellipse 60% 60% at center, black 0%, transparent 70%)` 径向淡出边缘，仅桌面显示 | 可（重型，需 GLSL，成本高） |
| ② 中层 | **Canvas 2D 粒子连线网络** | 顶部区域 `top-[80px] h-[500px]`：小球散布（dotColor `rgba(60,100,160,..)`）+ 距离近则连线（lineColor `rgba(60,100,160,..)`），`requestAnimationFrame` 逐帧动画，带鼠标扰动 | **易（轻量、零依赖、官方推荐落点）** |
| ③ 上层 | **纯 CSS radial-gradient 光斑** | 三团底部蓝光晕：`radial-gradient(circle,#1A3870 0%,transparent 70%)` + `blur(80px)`、`ellipse #2D5F9E→#1A3870→transparent` + `blur(100px)`、`circle #4A8AC4→#2D5F9E→transparent` + `blur(60px)`，分布在 bottom-left/center/right，`opacity .3/.4/.2` | 易（纯 CSS，零成本） |

**推荐方案（给 developer）**：采用 **② Canvas2D 粒子网络 + ③ CSS 光斑** 的混合方案，可零依赖复现官网「动态流动 + 粒子连线」的核心观感，成本低于 WebGL shader；① GLSL 云雾作为进阶/可选（若追求完全一致再启用）。

**落地要点**：
- 颜色不得硬编码官网的蓝色（`#1A3870/#2D5F9E/#4A8AC4`），要**用本项目 CSS 变量派生**：`--accent`（绿 `#5BAF68`）作主光色、`--bg`/`--bg-panel` 作底、`--text-dim` 作粒子色，亮/暗主题自动适配。
- 渲染位置：挂在 `AppShell.tsx` 根容器（`background:var(--bg)` 那个 flex 容器）内部**最底层**、绝对定位 `z-index:0`、`pointer-events:none`，不遮挡交互。
- 尊重 `prefers-reduced-motion`：系统要求减弱动画时停用动画（项目 globals.css 已有此媒体查询先例）。
- 性能：粒子数限 `<canvas>` 视口自适应 + 帧率上限（~30fps），暗色下注意对比度。

---

## 二、依据（可验证来源）

### 1) 官网 HTML 抓取（证据）
来源 URL：https://www.deepseek.com/harness/en/
抓取命令输出（curl 到临时文件后读原文），下述关键片段均取自页面源码：

**① 底层 GLSL 云雾层** —— 页面内嵌 `<canvas>` + `mix-blend-mode:screen` + 径向 mask：
```
<div class="absolute -inset-[30%] z-0 pointer-events-none hidden md:block"
     style="mix-blend-mode:screen;transform:translateY(-8%);
            mask:radial-gradient(ellipse 60% 60% at center, black 0%, transparent 70%)">
  <!-- canvas（WebGL，RSC streaming 注入） -->
</div>
```

**② 中层粒子连线网络** —— `top-[80px] left-0 w-full h-[500px]` + canvas 2d：
```
<div class="absolute top-[80px] left-0 w-full h-[500px] pointer-events-none z-0" style="opacity:0;transform:scale(0.85)">
  <div class="absolute inset-0" style="mask:linear-gradient(...至边缘透明)">
    <canvas style="position:absolute;top:0;left:0;width:100%;height:100%;background:transparent"></canvas>
  </div>
  ...
</div>
```

**③ 上层 CSS 光斑**（三团，均为 `filter:blur(...)`）：
```
<div class="absolute bottom-[-100px] left-[10%] w-[500px] h-[500px] opacity-30"
     style="background:radial-gradient(circle,#1A3870 0%,transparent 70%);filter:blur(80px)"></div>
<div class="absolute bottom-[-50px] left-[50%] -translate-x-1/2 w-[700px] h-[400px] opacity-40"
     style="background:radial-gradient(ellipse at center,#2D5F9E 0%,#1A3870 40%,transparent 70%);filter:blur(100px)"></div>
<div class="absolute bottom-[-80px] right-[10%] w-[400px] h-[400px] opacity-20"
     style="background:radial-gradient(circle,#4A8AC4 0%,#2D5F9E 30%,transparent 70%);filter:blur(60px)"></div>
```

### 2) JS chunk（动画逻辑证据）
来源 URL：https://www.deepseek.com/harness/_next/static/chunks/app/%5Blocale%5D/page-07f506a1408ad0e8.js
抓取到的关键字符串确认了 shader 配方与粒子网络参数：

- WebGL shader uniform 默认值：
  `noiseBoost:.3, swirlBoost:.8, glowIntensity:.13, glowColors:["#fff7d1","#538dca","#2d448b"], speed:28, scale:1.77`
  （暖黄 #fff7d1 + 天蓝 #538dca + 深蓝 #2d448b 三色，`u_time` 时间驱动，`noise()/snoise()` Perlin 噪声 + `flow follows the glow` 流场 + 鼠标扰动）
- 粒子网络（Canvas2D）：
  `let{lineColor:"rgba(60, 100, 160,", dotColor:"rgba(60, 100, 160,"…`；`getContext("2d")`；`requestAnimationFrame(k)` 逐帧；`mask:linear-gradient(#000000fc 0%, #000000e8 8.98%, transparent 100%)` 淡出。

### 3) 项目结构（集成点证据）
- 背景 CSS 变量：`app/globals.css` → `:root {--bg:#F6F6F3; --accent:#5BAF68;}` / `html.dark {--bg:#1B1D20; --accent:#76C97E;}`，`body {background:var(--bg)}`。
- 主容器：`components/AppShell.tsx` 根 flex div，`background:var(--bg)`，`overflow:hidden`（第 ~1780 行附近），已内置 `<style>` 注入区块（AppShell return 顶部的 style 标签），可复用该机制注入背景 CSS。
- 主题切换：`hooks/useTheme.ts` 用 `document.documentElement.classList.add/remove("dark")` 驱动，亮暗自动经由 CSS 变量反映——背景层颜色用 CSS 变量派生即可自动适配。

---

## 三、风险与注意事项

| 风险 | 说明 | 缓解 |
|------|------|------|
| **纯 CSS 方案效果不足** | 组长预设偏向「轻量 CSS radial-gradient」。但实测官网动态核心是 canvas 动画（流动云雾+粒子连线），纯 CSS 只能还原静态光斑与静态渐变，**观感达不到「参考官网」目标**，用户可能不满意 | 采用 Canvas2D 粒子网络（零依赖）+ CSS 光斑混合，平衡成本与还原度 |
| **硬编码颜色破坏主题** | 直接复制官网蓝色会与绿色主题/亮暗主题冲突 | 全部改用 `var(--accent)/var(--bg)/var(--text-dim)` 派生，亮暗自动切换 |
| **性能 / 电池** | 每帧 canvas 绘制在无 SSR 的桌面 Electron 上持续运行动画，占 GPU/CPU | 限制粒子数量、~30fps 帧率上限、`prefers-reduced-motion` 停用、tab 隐藏时 rAF 自动暂停 |
| **遮挡交互** | 背景层若 pointer-events 干扰鼠标/点击 | 背景容器 `position:absolute; inset:0; z-index:0; pointer-events:none`，App 主体在更高 z；粒子网络鼠标扰动仅监听不拦截 |
| **a11y（减弱动画）** | 部分用户 / 系统节能开启 reduce-motion | 用 `matchMedia('(prefers-reduced-motion: reduce)')` 判断，不启动动画（项目 globals.css 已有先例） |

---

## 四、给 developer 的实现建议（落地速查）

1. 新建组件（如 `components/GlowBackground.tsx`），render 一个 `fixed/absolute inset-0 z-0 pointer-events-none` 层：
   - 3 个 `<div>` 用 `background:radial-gradient(...)` + `filter:blur(...)`，颜色用 `color-mix(in srgb, var(--accent) X%, transparent)` 派生态，分布左/中/右下三方。
   - 1 个 `<canvas>` 实现粒子连线网络：小球 `fillStyle: color-mix(... var(--accent))`、连线 `globalAlpha` 随距离衰减、`requestAnimationFrame`、鼠标 hover 微扰、`ResizeObserver` 自适应尺寸。
2. 挂载到 `AppShell.tsx` 根 flex 容器内最顶部（首个子元素），置于现有各面板之下（z-index 0）。
3. 动画配色亮暗自适应：暗色用更高透明度光斑、亮色降低不透明度，均从 `var(--accent)` 派生。
4. 集成 `<style>` 或组件内联样式均可（项目已有 AppShell `<style>` 注入先例）。
5. 交 tester 验证：tsc --noEmit + npm run lint（对改动文件定向 lint，避开 release/ 打包目录的大量既有 error）+ 浏览器观察亮/暗两种主题下的效果与交互可用性。

---

## 五、来源清单
- https://www.deepseek.com/harness/en/ （HTML：三层背景结构，curl 抓取）
- https://www.deepseek.com/harness/_next/static/chunks/app/%5Blocale%5D/page-07f506a1408ad0e8.js （GLSL uniform 参数 + 粒子网络代码）
- 项目内：`app/globals.css`、`components/AppShell.tsx`、`hooks/useTheme.ts`（集成点与主题机制）
---

## 六、实施状态核验（本 run 更新 · researcher 复核）

**重要结论：动态背景组件已在项目中落地，且与「推荐方案 ②+③」完全一致。**

### 已核实现状（依据 = 项目文件 + 官网抓取，非口头断言）

| 项 | 实测结果 | 依据 |
|----|---------|------|
| 官网三层结构 | 确认：`canvas` + `mix-blend-mode:screen` + 三团 `radial-gradient`（#1A3870/#2D5F9E/#4A8AC4）+ `filter:blur` + `mask` | curl 抓取 https://www.deepseek.com/harness/en/ （本 run 复核，仍生效） |
| 粒子网络已实现 | `components/GlowBackground.tsx`：Canvas2D 粒子 + 距离连线 + `requestAnimationFrame` + ~30fps 上限 + 鼠标扰动 + ResizeObserver 自适应 | read 组件全文 |
| CSS 光斑层已实现 | 三个 `.glow-blob`（左/中/右，radial-gradient + blur，`color-mix(var(--accent))` 派生，亮/暗不透明度不同） | read 组件全文 |
| 已挂载 | `AppShell.tsx` 根 flex 容器首个子元素 `<GlowBackground />`，`position:fixed;inset:0;z-index:0;pointer-events:none` | grep + read AppShell 第 26/1191 行 |
| 主题自适应 | 用 `useTheme().isDark` + 每 120 帧重读 `var(--accent)/var(--text-dim)`；颜色全部 CSS 变量派生 | read 组件全文 |
| reduce-motion | 组件内部 `matchMedia('(prefers-reduced-motion: reduce)')` 判断，关闭动画循环 | read 组件全文 |
| 编译通过 | `tsc --noEmit` 无 GlowBackground / 无 error | 命令输出 |
| git 状态 | `?? components/GlowBackground.tsx`（未跟踪，尚未提交）；无 globals.css 样式（用内联样式） | git status/ls-files |

### 对后续角色的建议（避免重复劳动 / 冲突）

- **developer（TASK-002）**：**无需重新实现** —— 推荐方案（② CSS 光斑 + ③ 粒子网络）已在 `GlowBackground.tsx` 完整落地并挂载。建议仅做**轻量集成复核**：确认挂载位置 z-index 不遮挡交互、亮/暗主题切换颜色跟随、非 Electron 纯浏览器模式无副作用；**不要再新建组件/重复 canvas**，避免与现有文件冲突。
- **tester（TASK-003）**：验证重点 = ① tsc --noEmit + 定向 lint（改动的组件文件）；② 浏览器亮/暗两种主题下手动观察动效观感与交互可用性（粒子连线、光斑、鼠标扰动、窗口 resize）；③ 确认背景层 `pointer-events:none` 不影响点击/输入。
- **可选进阶（不阻塞）**：WebGL GLSL 流动云雾（层① = `mix-blend-mode:screen` + shader `noiseBoost/swirlBoost/glowIntensity` + `u_time`）未启用，属于"完全复刻官网"的进阶项，性能/成本更高，本期建议不做。

### 风险点（本 run 复核后新增）

| 风险 | 说明 | 缓解 |
|------|------|------|
| 与现有工作区冲突 | GlowBackground.tsx 为未跟踪新文件，若 developer 另起炉灶会产生两份实现 | developer 先 read 现有文件再决策，勿重复造 |
| 纯浏览器模式无桥 | AppShell 中已挂载，但若 DOM 在某些页面重建需确认 React 卸载时 cancelAnimationFrame 清理（组件已实现 cleanup） | tester 在 dev 模式（非 Electron）验证无 console 报错 |
| 视觉过强干扰内容 | 亮色下光斑透明度偏低(0.16)，但仍需主观确认不抢内容 | tester 主观判断，必要时调低 opacity |

---

**结论**：本轮 leader→researcher 的调研目标已完成并复核通过。官网三层结构已验证，推荐方案已在 `components/GlowBackground.tsx` 落地并接入 `AppShell.tsx`（tsc 通过）。下一步符合预期：developer 做集成复核，tester 做功能/质量验证，均无需重新实现动态背景。
