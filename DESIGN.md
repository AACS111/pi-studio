# DESIGN.md — Pi Studio 设计契约

> 从 `app/globals.css` 现有 token 与 `components/*.tsx` 实际用法**反向抽取**（2026-09-19），
> 不是理想规范：**「现值」= 代码里真实生效的值**，「规则」= 今后必须遵守的约束。
> 与代码冲突时以代码为准并立即更新本文件。产品定位见 PRODUCT.md（尚未撰写）。
> 生成工具：`.agents/skills/ui-design/`（`--context` 探测 / 阶段 5 独立视觉评审）。

## 0. 视觉世界观

Pi Studio 是**长时间驻留的开发工作台**（Operate 型界面），不是展示页。基调：

- **单一冷灰（slate）家族**承载全部表面：canvas 极浅灰 → panel 纯白 → elevated 纯白。
  中间**禁止**再插入 `#ECECEC`/`#B8B8B8` 那种「重灰 + 硬边」，会在白底旁显脏（源码注释已记录此坑）。
- **彩色只有一种职责**：`--accent` 承担强调 / 选中 / 进行中。动态背景与 accent 图标携带色彩，
  **基底永远保持干净**。
- 身份靠**精确细节**建立：一个字族体系、一套表面、一档半径阶梯。表现力（玻璃、GlowBackground 星图）
  只用在浮起层与桌面壳，**不进入高频操作面**。
- 桌面（Electron transparent 窗口）下卡片之间透出壁纸，靠 `backdrop-filter` 磨砂成玻璃；
  浅色根背景透明、深色模糊下层星图。**可读性由不透明度驱动**，不靠加边框补救。

## 1. Token 清单（现值）

### 1.1 表面与描边

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` | `#F7F8FA` | `#0D0F12` | 页面/工作区底层（深色禁止纯黑，此处带冷相） |
| `--bg-panel` | `#FFFFFF` | `#15181D` | 卡片、面板表面 |
| `--bg-elevated` | `#FFFFFF` | `#1B1F25` | 浮起层（下拉/菜单/弹窗） |
| `--bg-sunken` | `#F1F3F6` | `#0A0B0E` | 凹陷区（代码块、输入槽） |
| `--bg-hover` | `rgba(15,23,42,.045)` | `rgba(255,255,255,.055)` | 悬停 |
| `--bg-selected` | `rgba(15,23,42,.085)` | `rgba(255,255,255,.085)` | 选中 |
| `--bg-subtle` | `rgba(15,23,42,.04)` | `rgba(255,255,255,.045)` | 极轻分区底 |
| `--border` | `rgba(15,23,42,.10)` | `rgba(255,255,255,.11)` | 常规描边 |
| `--hairline` | `rgba(15,23,42,.07)` | `rgba(255,255,255,.075)` | 分割线（**能用留白就别画线**） |

**规则**：描边基色固定为 slate `15,23,42` / 白，**禁止**自创第三种灰。

### 1.2 文字（含对比度硬约束）

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--text` | `#111827` | `#E6E8EB` | 标题与正文 |
| `--text-muted` | `#161C28` | `#ECF3FB` | 次级文字（**承载功能文字的下限档**） |
| `--text-dim` | `#242B3B` | `#D6DFEB` | 时间戳、工具名等最小字 |
| `--accent` | `#2563EB` | `#60A5FA` | 主操作 / 选中 / 进行中 |
| `--accent-hover` | `#1D4ED8` | `#93C5FD` | 主操作悬停 |
| `--accent-contrast` | `#FFFFFF` | `#0B1220` | accent 底上的文字 |
| `--accent-rgb` | `37, 99, 235` | `96, 165, 250` | 供 `rgba(var(--accent-rgb), α)` |
| `--accent-soft` | `rgba(accent,.09)` | `rgba(accent,.14)` | accent 极浅底 |
| `--user-bg` / `--assistant-bg` / `--tool-bg` | 见源码 55–70 行 | 同左 | 三种消息气泡底 |

**这是本项目最贵的一条经验**：`--text-muted` / `--text-dim` 在浅色下**不是装饰性灰字**，
桌面玻璃下文字坐在「石板灰纱 + 半透明白卡」上（实测底约 `#cbd2db`），比纯白底暗一档，
2026-09 做过**五轮压深**：dim 对比度 3.88 → 5.36 → 6.75 → 8.0 → **9.3**，
muted 4.79 → 6.16 → 8.48 → 9.9 → **11.0**；深色反向（提亮）muted → 16.2、dim → 13.0。

- **规则 1**：任何新文字**禁止**使用低于 `--text-dim` 灰阶的字面量。算过才知道：
  `#6B7280` 在纯白底上刚好 4.50:1（踩线），但在桌面玻璃实测底 `#cbd2db` 上只有 **3.17:1，不达 AA**。
  （旧版本文件写的「3.88」是别的历史值，已用 `static-check.mjs` 重算纠正。）
- **规则 2**：muted 必须深于 dim，两档之间始终保留「一档」差距，禁止合并成一档。
- **规则 3**：改这两档前必须重新按**玻璃实测底**（不是纯白）计算对比度，小字 <16px/常规重需 ≥ 4.5:1。
- **规则 4**：层级靠**字重**而非字号建立（12.5px/700 优于 14px/400），因为 UI 尺度小、需要更高信息密度。

### 1.3 字族与字阶

| token / 场景 | 现值 |
|---|---|
| UI 字族 | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', sans-serif`（14px 基准）—— ⚠️ **未 token 化**，硬编码在 `body` |
| 等宽 `--font-mono` | `'SF Mono', var(--font-noto-mono), 'JetBrains Mono', 'Fira Code', 'Consolas', ui-monospace, 'PingFang SC', 'Microsoft YaHei', monospace` |
| Tailwind 桥接 | `@theme` 内 `--color-*` 别名（CSS-first，故 `tailwind.config.ts` 的 `extend` 为空是**正常**的） |

**已知违约（字阶）**：`globals.css` 现有 **11 种字号**，含 4 个半档 `10.5 / 11.5 / 12.5 / 13.5`，
另有 `text-[13px]` 出现在 2 个组件里。
**规则（新代码强制）**：字阶收敛到 `10 / 11 / 12 / 13 / 14 / 16 / 19`，**禁止新增半档**；
动到附近代码时顺手并档。禁止第二套无衬线字族混入。

### 1.4 半径与海拔

- 半径阶梯（统一 5 档，替代散落的 5/7/9 魔法数字）：
  `--radius-xs 6` / `--radius-sm 8` / `--radius-md 10` / `--radius-lg 14` / `--radius-xl 18` / `--radius-pill 999`
  玻璃卡另用 `--glass-card-radius: 16px`。
  **规则**：控件 < 卡片 < 浮层；禁止单值通吃，禁止阶梯外数值。
- 阴影：`--shadow-xs / --shadow-sm / --shadow-md / --shadow-lg(=--shadow-pop)`，
  全部**冷灰 slate 基色**（源码注明「不用纯黑，避免发脏」）。
  **规则**：一个表面只用**一种**区分手段——描边 **或** 阴影 **或** 底色，禁止三件全上。

### 1.5 玻璃（浮起层专用）

| token | 浅色 | 深色 |
|---|---|---|
| `--glass-blur` | `blur(24px) saturate(1.35)` | 同左 |
| `--glass-bg` | `color-mix(--bg-panel, 52%)` | `color-mix(--bg-panel, 72%)` |
| `--glass-card-surface` | 顶部淡 accent 染 `linear-gradient(180deg, --glass-tint, transparent 46%)` + `--glass-bg` | 同左 |
| `--glass-card-shadow` | `0 18px 46px rgba(15,23,42,.13), 0 2px 10px rgba(15,23,42,.07)` | `0 20px 52px rgba(0,0,0,.46), …` |
| `--glass-card-edge` / `--gap` | `12px` / `10px` | 同左 |
| `--glass-tint` | `color-mix(in srgb, var(--accent) 5%, transparent)` | 同左 |

- 不透明度由「设置 → 桌面玻璃」两滑块驱动（`useGlassOpacity` 写 `:root` 行内样式，行内优先级高于此处）。
- **降低透明度可访问性**：把卡片间缝隙与模糊**关成实色**，靠边框 + 阴影分层
  （`--glass-card-edge/gap: 0` + `--glass-blur: none`）。
  ⚠️ 关闭模糊**必须**改这两个变量，直接写 `backdrop-filter: none` 会被上层规则覆盖（已踩过）。
- **已知违约**：源码另有 3 处手写配方 `blur(20px) saturate(1.35)`、`blur(22px) saturate(1.5)`、
  `blur(8px) saturate(1.2)`。**规则**：新代码一律引用 `--glass-blur`，禁止手写 blur 值。

### 1.6 间距节奏

`globals.css` 实测分布（次数）：`6×16, 8×9, 4×9, 3×8, 2×7, 12×7, 10×6, 1×5, 7×4, 5×3, 9×1, 28×1`
→ **尚无真正刻度**，事实上以 4 的倍数为主，混入 1/2/3/5/6/7/9。

**规则（新代码强制）**：刻度定为 **4 / 8 / 12 / 16 / 24 / 32 / 48**（紧凑场景允许 2，须成对出现于 hairline 级），
组内间距 ≤ 组间间距的一半；触碰附近代码时把非刻度值并到最近档位。

### 1.7 语义色（未 token 化 —— 待收编）

现状：全局**无** `--warn/--ok/--danger/--info`；仅 `.session-info-modal` 有局部
`--si-warn #b45309 / #fbbf24`、`--si-danger #dc2626 / #f87171`（浅/深两套）。
组件里 Tailwind 原生语义色仅 2 处（`text-red-400`、`text-green-500`）——**问题面很小，但别再扩大**。

**规则**：新增告警/成功/危险态优先提 `--si-*` 为全局 token（`--warn`/`--danger`/`--ok`）后引用；
accent 禁止兼任进度或警告色。

### 1.8 动效

- 时长：微反馈 `120–160ms`、表面进出 `200–280ms`、大位移 `≤400ms`（现值散落于源码，新代码取此三档）。
- **规则**：位移越小时长越短；同屏禁止 >2 层同时动画；必须响应 `prefers-reduced-motion`。
- 过渡属性成对写全（`transition: color .12s, border-color .12s, background .12s`），禁止裸 `all`。

## 2. 组件契约（现有约定）

- **所有弹窗**统一用 `components/DraggableResizableModal.tsx`（createPortal 挂 body、zIndex 9999、
  8 方位把手 + 顶栏拖动）。**禁止**新写固定尺寸 / 纯 `fixed` / 不可拖动缩放的弹窗。
  比例式弹窗（如展开画布）允许，但必须把初始高度按百分比算并保留把手与 `maxHeight` 兜底。
- **按钮**：主操作 = `--accent` 底 + `--accent-contrast` 字；次操作 = 描边 + `--bg-elevated`；
  三级 = 幽灵（透明底，hover 才出 `--bg-hover`）。尺寸必须紧凑以匹配画布尺度。
- **密度**：会话列表、文件树、表格等长驻列表以「扫读效率」为最高优先，
  行高统一、数字用 `--font-mono` 对齐、时间戳走 `--text-dim`。
- **空状态**：必须给出下一步动作入口，禁止只留一句「暂无数据」。
- **i18n**：所有可见文字走 `lib/i18n/`（en / zh-CN），组件内禁止硬编码中文——
  UI 文案必须同时给出两种 locale，**禁止把中文写进 t() 的 fallback 串**。

## 3. 禁令汇总（评审时按此判违规）

1. 组件内出现字面量色值（`rgba(` / `#hex`）而主题已有对应 token —— 现状 `components/*.tsx` 有
   **178 处 rgba + 329 处 hex**，其中多数属 Univer 主题对象 / SVG / 渐变等**体系外**用法，
   不追溯；但**新的**表面色与文字色一律走 token。
2. 手写 `backdrop-filter: blur(Npx)`（见 1.5）。
3. 新增半档字号（10.5/11.5/12.5/13.5）或阶梯外圆角。
4. 表面同时使用 边框 + 阴影 + 底色 三件。
5. 高频操作面加渐变 / 光晕 / 粒子 / 纹理装饰。
6. 用 emoji 充当功能图标。
7. 一屏没有可一眼指认的第一焦点（层级平铺）。
8. 新弹窗不用 `DraggableResizableModal`。

## 4. 资产

- 字体：不引入 Web Font 依赖（系统栈 + Noto Sans Mono via `next/font`，见 `app/layout.tsx`）。
- 背景：GlowBackground 星图（仅 Electron 桌面 / 深色层）。
- **不生成**图片 / 图标 / 插画：占位用虚线盒 + `data-` 标签 + 精确 px 尺寸，并记入交付报告。

## 5. 自检清单（每次 UI 改动前后）

- [ ] 只用了本文件的 token，未新增字面量
- [ ] 第一焦点明确；层级 ≥ 3 倍差
- [ ] 同节奏控件共享同一间距/尺寸；新值落在刻度上
- [ ] 小字对比度按**玻璃实测底** ≥ 4.5:1（不是按纯白算）
- [ ] 浅色 + 深色两套都成立
- [ ] 1440 与 900 两档宽度不崩
- [ ] `prefers-reduced-motion` / `prefers-reduced-transparency` 有响应
- [ ] 截图过独立视觉模型一轮（`.agents/skills/ui-design` 阶段 4–6）
