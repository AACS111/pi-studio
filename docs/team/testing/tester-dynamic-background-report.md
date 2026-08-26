# 测试验证报告 — DeepSeek Harness 动态背景（TASK-003）

- 测试角色：tester
- 日期：2026-08-25
- 任务：参考 https://www.deepseek.com/harness/en/ 官网动态背景效果，为本项目添加同款动态背景
- 验证对象：`components/GlowBackground.tsx`（新文件）+ `components/AppShell.tsx`（集成挂载）
- 结论：**通过（PASS）**

---

## 一、需求与验收对照

| 需求点（来自调研报告推荐方案 ②+③） | 验收标准 | 验证结果 | 结论 |
|-----|------|------|------|
| CSS 模糊光斑层（③） | 3 团 radial-gradient + blur，左/中/右分布，颜色从 var(--accent) 派生，亮暗自适应 | `GlowBackground.tsx` 三个 `.glow-blob`（left/center/right），均 `color-mix(in srgb, var(--accent) X%, transparent)` + `filter:blur(60-100px)`，`isDark` 控制不同 opacity（dark 0.22/0.3/0.18 vs light 0.16/0.18/0.12） | ✅ 通过 |
| Canvas2D 粒子连线网络（②） | 粒子散布 + 距离近连线 + requestAnimationFrame + 鼠标扰动 | canvas getContext("2d")，粒子数组、`LINK_DIST=140` 连线、`requestAnimationFrame` 逐帧、鼠标 hover 微扰（120px 内）、`pointer-events:none` 容器 | ✅ 通过 |
| 集成挂载 | 挂最底层、z-index:0、不遮挡交互 | `AppShell.tsx` 根 flex 容器首个子元素 `<GlowBackground/>`，`position:fixed;inset:0;zIndex:0;pointerEvents:none`；sidebar z-index:200、mobile backdrop z-index:199、chat/右侧面板均为不透明 `var(--bg-panel)/var(--bg)` 覆盖其上 | ✅ 通过 |
| 主题自适应 | 亮/暗主题自动切换颜色，不硬编码 | `useTheme().isDark` + 每 120 帧重读 `var(--accent)/var(--text-dim)`；CSS 变量均在 `app/globals.css` `:root`/`html.dark` 定义 | ✅ 通过 |
| prefers-reduced-motion | 系统要求减弱动画时停用 | `matchMedia('(prefers-reduced-motion: reduce)')` 判断，不启动动画循环与鼠标扰动；全局 globals.css 亦有先例 | ✅ 通过 |
| 性能 | 帧率上限、粒子数自适应 | `FPS_CAP=30`、粒子数 min 40 / max 180 按视口面积缩放、ResizeObserver 自适应、隐藏 tab rAF 自动暂停 | ✅ 通过 |
| 资源清理 | 卸载时无泄漏 | cleanup：`cancelAnimationFrame` + `removeEventListener` + `ro.disconnect()` | ✅ 通过 |

## 二、编译/静态检查（实跑）

| 检查项 | 命令 | 结果 |
|------|------|------|
| TypeScript | `node_modules/.bin/tsc --noEmit` | **0 error**（全项目，含新组件） |
| ESLint（改动文件） | `eslint components/GlowBackground.tsx components/AppShell.tsx` | GlowBackground **0 error 0 warning**；AppShell 仅 5 条**既有**未用变量 warning（`ReactNode`/`isDark`/`setLocale`/`supportedLocales`/`setSidebarWidth`，与本次改动无关，非新增） |

## 三、真实验证明细

1. **组件存在**：`components/GlowBackground.tsx` 已 read 全文，逻辑完整（无半截代码、无未定义引用）。
2. **集成点**：`AppShell.tsx` import + JSX 首子元素挂载确认；CSS 变量依赖均已核实存在于 globals.css。
3. **依赖一致性**：`useTheme()` 暴露 `isDark`（hooks/useTheme.ts:84），`useAccentColor` 亦使用同一签名 —— 组件调用方式与现有组件（FileViewer/MermaidBlock/TerminalPanel）一致。
4. **不遮挡交互**：背景容器 `pointer-events:none`，鼠标扰动仅 `mousemove` 监听不消费事件；顶栏/侧栏/聊天区/右侧面板均有不透明背景层置顶。

## 四、发现的问题

**未发现阻塞性问题。** 以下均为备注（严重程度：提示/低，不阻塞交付）：
1. **[提示] `color-mix()` 与 CSS `translate` 依赖现代 Chromium**：`GlowBackground` 使用 `color-mix(in srgb,...)`（Chrome 111+）与 `translate` 定位属性。本应用目标环境为 Electron（内嵌 Chromium），满足要求；但若未来做纯浏览器跨引擎兼容需注意。属环境假设，非代码缺陷。
2. **[提示] 需浏览器肉眼确认观感**：动效最终观感（光斑强度、粒子密度、明暗对比）依赖主观判断，建议用户在 Electron 桌面应用（`npm run dev:electron`）下观察亮/暗两主题确认效果符合预期。代码层面已具备全部能力且参数合理。

## 五、结论

**PASS — 动态背景功能实现正确、集成到位、编译通过。**

- 实现了「③ CSS 光斑 + ② Canvas2D 粒子连线」双层的官网同款动态背景，与调研推荐方案完全一致，无多实现/重复 canvas（调研报告曾提示防重复）。
- 集成于 AppShell 最底层，不遮挡任何交互，亮暗主题与 reduce-motion 均自适应。
- tsc 0 error、改动文件 eslint 0 error（仅 AppShell 既有 warning）。
- 无需返工。可选增强（非本期范围）：WebGL GLSL 流动云雾（层①）作为完全复刻官网的进阶项。