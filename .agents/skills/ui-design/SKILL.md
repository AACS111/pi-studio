---
name: ui-design
description: "UI 设计的**唯一入口**（排他）：任何页面/组件/样式/布局/主题/配色/文案可视化的新建或改动，都必须用本技能，**不得因为其它设计类技能（如 frontend-design、impeccable、minimalist-ui 等）描述得更细分就改选它们**——本技能负责编排，它们只是本技能内部可叠加的参考。本技能自带强制六阶段流水线：读 DESIGN.md（缺则就地从项目现有 token 抽取）→掷 direction-seed 外部种子后出 6 个互斥**交互范式**方向→**停住等用户选 1 个**→实现→右侧浏览器截图→用另一个多模态模型只看截图打分→一次性批量修正（硬上限 2 轮）。禁止看完需求直接改组件代码。Use for ANY new or changed user-visible interface in ANY project (works in the packaged desktop app and in any cwd): pages, screens, panels, dialogs, forms, tables, settings, empty states, onboarding, restyling, critiques. The direction-exploration and screenshot-review steps are mandatory, not optional. Not for backend-only or non-visual tasks."
---

# UI 设计流水线（ui-design）

> 一句话：**「更有设计感」不是靠更强的模型，而是靠换模型当评审 + 先定方向再动手。**
> 单模型自评必然自我恭维（只会提「圆角加大、加点留白」）；让另一个多模态模型
> **只看截图**打分，才看得见「层级塌了、三个对齐的控件没共享节奏」。

本技能随 Pi Studio 分发（`lib/bundled-skills.ts` 在启动时把它同步到 `~/.agents/skills/`），
所以在**任意 cwd 的任意项目**里都能用，不依赖本仓库。

### 路径解析（先做这一步）

下文用 `$SKILL_DIR` 指代本技能的加载基目录。**每个会话开头解析一次**：

```bash
# 1) 优先用运行时报告的本技能 base directory；2) 其次用 Pi Studio 注入的环境变量；3) 最后回退全局目录
SKILL_DIR="${PI_STUDIO_USER_SKILLS_DIR:-$HOME/.agents/skills}/ui-design"
[ -f "$SKILL_DIR/scripts/design-review.mjs" ] || SKILL_DIR="$PI_STUDIO_SKILLS_DIR/ui-design"
echo "$SKILL_DIR"
```

解析失败（脚本不存在）就直接用绝对路径调用，别猜相对路径——会话 cwd 是用户的项目，
`.agents/skills/ui-design/...` 这种仓库相对路径在别人的项目里永远命不中。

---

## 何时必须触发（写进 description 的硬条件）

只要任务会产生**用户可见的界面变化**，就走本流水线，不得跳过：

- 新页面 / 新面板 / 新弹窗 / 新视图 / 新组件
- 改布局、改配色、改主题、改字号字距、改间距节奏、改动效
- 「优化一下这个页面」「这里不好看」「做得高级一点」这类主观诉求
- 用户给出宽约束（Apple 风格 / 现代 / 简洁 / 科技感 / 高级感）——**这恰恰是最需要走流程的情况**，
  因为宽约束不携带方向信息（见阶段 0 的说明）

**禁止**：看完需求直接 `edit` 组件文件。先出方向、拿到选择、再动手。

---

## 阶段 0 · 落地设计真相（每个项目一次，幂等）

先确认项目根有 `PRODUCT.md` 与 `DESIGN.md`；没有就生成，有就加载：

```bash
node "$SKILL_DIR/scripts/design-review.mjs" --context        # 只探测并报告
```

- 缺 `PRODUCT.md` → 用 `templates/PRODUCT.md.template` 落盘。**问用户 4 个问题**
  （产品是什么 / 给谁用 / 什么场景 / 什么绝不做），1–2 轮问完；用户没回答就继续做，
  但必须**显式标注为推断**。
- 缺 `DESIGN.md` → **就地抽取现有视觉真相**，不要套别的项目的 token：
  读 CSS 变量（`@theme` / `:root`）、Tailwind theme、设计资产、代表性组件，
  按 `templates/DESIGN.md.template` 写成**可判真假**的祈使句（每个属性一个 token 名，
  含精确色值/字重/时长），落盘到项目根 `DESIGN.md`。
- 两者都齐 → 每次动手前加载；非谈判的 token 约束 > 用户临时偏好的表面效果。

> 宽约束（Apple / 现代 / 简洁 / 高级感）**不携带方向信息**，堆更多这类词只会让模型回到
> 它最常见的输出。真正的方向来自阶段 1 的探索；宽泛的风格词一律换成
> **具体参照物 + 明确禁令 + token 数值**。

---

## 阶段 1 · 方向探索（默认 6 个，用户可改数量）

**先想内容、后想界面**：产品要说什么、为谁服务，答案必须来自 `PRODUCT.md` 与代码，
不能来自「用户说想要玻璃感」。要打破的默认套路，得先看清楚它是什么——
**先掷骰（硬步骤，不可省略）**：

```bash
node "$SKILL_DIR/scripts/direction-seed.mjs" --count 6
```

它会返回 `must_avoid`（本品类那套 everyone-tuned-out 的默认构图）、`assigned`（2 个**必答**
非直觉范式，附 known_failure）与 `optional_pool`。**只换皮肤与色板、布局与交互完全相同的
6 个方案，视为无效探索**（用户看上去「区别不大」就是踩了这个坑）；配色属于选定范式之后的
细化层，不在本阶段充当差异。

每个方向**必须互斥到能一眼分开**，只换配色不算独立方向。每个方向交两份：

1. **ASCII 线框**（`++`/`||` 标边界，画结构、对齐、留白，不画颜色）
2. **视觉语言说明**：字体、色彩体系、图形语言、层级怎么建、动效基调
   —— 并写一句「这个方向刻意打破了哪个套路」

方向来源三条腿，缺一就偏：
- **项目内在逻辑**：真实对象、工作流程、隐喻（优先，它保证「只有这个产品能长这样」）
- **外部知识**：品类史、其他领域的视觉语言、设计师与流派
- **随机种子**：就是上面那条 `direction-seed.mjs`，**不是文字提个要求就能替代的**——
  同一模型 30/35 次交出完全相同的概念（跨 16 种提问措辞不变），它自己掷不出骰子。
  指派的方向若确实不适合本产品，**不许直接丢弃**：要么给出更优替代并说明理由，
  要么写出它在哪个真实场景下会赢。

**只出静态设计**：探索期不做交互，不做 mockup 包装（别套浏览器框/设备框，别放 lorem）。

## 阶段 2 · 选 1（停下，交回用户）

把 6 个方向**完整呈现**（不要压缩成标题摘要），然后**明确停住**等用户选。
除非用户已指定保留哪几个。用户选完才进阶段 3。

---

## 阶段 3 · 实现

按选定方向写代码，硬约束：

- **Operate 优先于 expression**：工作台/编辑器/列表/设置这类高频操作界面，
  可读性与扫描效率压倒美观，品牌只活在精确细节里（一个字体、一种表面、几个 token）。
  不要在操作面上堆渐变、粒子、玻璃——那正是「AI 味」的来源。
- 只用项目 token，禁止 ad-hoc 数值（见 `DESIGN.md`）。
- 一个界面只允许**一个焦点元素**；层级要陡（尺寸/字重/颜色对比至少差 3 倍），
  不许「所有卡片长得一样」。
- 图标/插画/图形/照片**一律不画不生成**——留占位（虚线盒 + `data-` 标签 + 精确 px 尺寸）
  并记进最终报告的资产清单。

## 阶段 4 · 静态自检（不截图、不调模型，毫秒级）

```bash
node "$SKILL_DIR/scripts/static-check.mjs" --files components,app --tokens app/globals.css
```

**能算的缺陷不要靠眼睛判**（本阶段无任何网络/图片/模型依赖）：

1. **WCAG 对比度**：从 token 值直接算（实测与仓库注释完全吻合：`--text-dim` on 玻璃底 = 9.29 ↔ 注释记的 9.3）。
   透明色会先合成到底色上再算。可用 `--bg #cbd2db` 指定真实观察到的底色。
2. **token 违约**：组件里手写的 `#hex` / `rgb()` / `backdrop-filter: blur()` / `box-shadow` /
   阶梯外圆角 / 半档字号 / Tailwind 任意值（`text-[13px]`）。
3. **尺寸节奏**：单文件字号档数 >6 则报节奏失控。

退出码 0=无 P0；`--strict` 则有任何 finding 就非 0（可当门闸用）。

> 边界（必项知道）：静态检查**算不出**「装饰溢出到操作面」、「被视口裁切的残片/
> 重叠遮挡」、「整体是不是像 AI 做的」。这些交给阶段 5 的文本 Critic 推理，
> 以及**用户自己看一眼渲染结果**（你看页面比任何模型都快）。

## 阶段 5 · 独立评审（禁止生成方自评，不依赖图片）

评审方必须是**独立上下文**（另开会话或另一个模型），否则会自我恭维。
输入只给三样：**改动后的组件源码 + 渲染后的 DOM/CSS 结构 + `review-rubric.md`**，
不给它看生成时的思路。

```bash
node "$SKILL_DIR/scripts/static-check.mjs" --json > review-input.json   # 把确定性结果送给评审
```

交给评审的判法：
- **结构层**：从 DOM/CSS 能判的——层级是否只有一个主角、同组元素是否共享间距节奏、
  主操作与次操作是否在填充上区分、空状态是否有下一步、长文案是否会撑破布局。
- **契约层**：拿着 `DESIGN.md` 逐条对，违反即缺陷（这一层 static-check 已经把数据递到嘴边）。
- **套路层**：是否命中 rubric 第 0 节（紫蓝渐变 / 等宽三卡 / emoji 图标 / 只换配色没换交互）。
- 输出仍是**结构化 findings**（severity / region / violated_token / fix），不是散文。

### 可选：视觉评审（默认不走，不要主动开启）

只在**同时满足**「有 Electron 右侧浏览器桥」+「配了支持图片的视觉模型」+「用户明确要求看图评审」时才用：

```bash
node "$SKILL_DIR/scripts/design-review.mjs" --shot --out ui.png      # 拍右侧浏览器（仅 Electron）
node "$SKILL_DIR/scripts/design-review.mjs --review --in ui.png --model provider/modelId
```

实测代价（为何默认不用）：慢且挑模型——kimi-k2.7-code 两次 100+ 秒并撞网关 504
（把输出预算提到 8192 后上游自己先断），且相当一部分模型根本不支持图片输入。
qwen3.8-flash / glm-5.3-flash 可用（直出紧凑 JSON）。

## 阶段 6 · 一次性批量修正

**批量评审一次 → 一次性修完 → 最多再验一轮 → 停。**
不要开放式自转 loop（会烧钱并做出更差的结果）。

### 何时才允许第 2 轮（硬门槛）

只有同时满足才继续：

1. 上一轮评审**确实提出了新问题**（不是重复同一个问题），且
2. 新问题**可在当前项目内落地修复**（不是缺真实素材、不是需求本身不明确、
   不是要外部服务/密钥才能做的事）。

不满足就停下，把未解决项写进最终报告交给用户。

---

## 交付

- 改动清单（文件 + 做了什么）
- 评审 findings 与对应修复
- 资产清单：所有占位待补的图形/图片/图标/字体
- 若本阶段生成了 `DESIGN.md` / `PRODUCT.md`，指出路径供用户校准（这两个文件是长期资产，
  下次改动直接复用）

## 相关（都是本技能内部的参考件，不得取代本流程）

- `frontend-design`（同目录随包分发，Apache-2.0）：阶段 1/3 的排印、调色、动效、构成深度参考。
- `impeccable`（用户自备时自动利用）：装了就用它的 `context.mjs` / `reference/*.md`（含 30+ 篇专题判例）
  作为阶段 1/3/5 的补充；`--context` 会探测并标注 `impeccable: available`。**但阶段 2 「停下等用户选」
  与阶段 5 「独立模型只看截图」这两步不得省略**。
- `minimalist-ui` / `redesign-existing-projects`：具体风格包，与本流水线正交。
  已标 `disable-model-invocation: true`（不自动触发），用户显式 `/skill:名字` 时才可当作阶段 1 的一个候选风格套用。
- `browser-control`：阶段 3/4 需要看真实渲染时用它截图/诊断页面（仅 Electron 桌面模式）；
  它不是阶段 4 的必经步骤，**默认用 `static-check.mjs` 做不依赖图片的静态自检**。
