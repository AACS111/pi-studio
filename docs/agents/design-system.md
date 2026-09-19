# 设计能力（ui-design skill / bundled skills）

> 谁改 UI 都按这条流水线走；本文件讲**机制与坑**，具体设计规则在根 `DESIGN.md`。

## 1. 为什么要有这一层

模型不缺设计知识，缺的是三件外部条件：

1. **方向探索**：同一模型在没有外部种子时会稳定收敛到它的 argmax 视觉习惯
   （实测口径：30/35 次交出完全相同的概念，跨 16 种提问措辞不变）→ 必须外部注入。
2. **独立评审**：生成方自评必然自我恭维（只会说「加大对比、圆角、留白」）。
   → 换一个**独立上下文**的 Critic。但**不等于必须看图**：文章另一半话更实用——
   「截图不会告诉你字体尺寸差了 5px，但规则会」。**能算的缺陷不要靠眼睛判**，
   所以默认走静态检查 + 文本评审（`static-check.mjs`），视觉评审降为可选。
3. **设计真相**：没有可判真假的 token 契约，评审只能凭感觉。→ 根 `DESIGN.md`。

Pi Studio 本来就有右侧浏览器截图 + 视觉模型两个零件，早期实现把它们串成了默认评审路径，
但实测**又慢又挑模型**（见 §7），于是降级为可选增强，默认只依赖确定性计算。
不依赖图片/视觉模型之后：全本地、毫秒级、所有模型可用、无需 Electron。

## 2. 组成

| 位置 | 作用 |
|---|---|
| `.agents/skills/ui-design/SKILL.md` | 六阶段强制流水线（阶段 0 落地设计真相 → 1 方向探索 → 2 选 1 → 3 实现 → **4 静态自检** → **5 独立文本评审** → 6 批量修正，硬上限 2 轮） |
| `.agents/skills/ui-design/scripts/static-check.mjs` | **阶段 4**：无网络/无模型/毫秒级——从 token 值算 WCAG 对比度、grep token 违约（硬编码色/手写 blur/阴影/阶梯外圆角/半档字号/Tailwind 任意值）、查字号节奏 |
| `.agents/skills/ui-design/scripts/direction-seed.mjs` | **外部方向种子**（必读步骤）：掷骰给出 must_avoid + 2 个必答非直觉范式 + 候选池，破模型 argmax 惯性 |
| `.agents/skills/ui-design/reference/paradigm-bank.json` | 12 张**交互范式**卡（axis/advance/density/layering/fits/known_failure）+ 4 个品类默认构图 |
| `.agents/skills/ui-design/reference/review-rubric.md` | Critic 的唯一评判标准（反 AI 味一票否决 + 层级/节奏/排印/色彩/克制 五轴打分） |
| `.agents/skills/ui-design/scripts/design-review.mjs` | 胶水：`--context` / `--shot` / `--review` / `--selftest` |
| `.agents/skills/ui-design/templates/{DESIGN,PRODUCT}.md.template` | 给**目标项目**落盘用的骨架 |
| `.agents/skills/frontend-design/` | 第三方（Apache-2.0）排印与视觉方向深度指导，随包分发 |
| 根 `DESIGN.md` | 本仓库的设计契约（从 `app/globals.css` 反向抽取，含已知违约清单） |

## 3. 分发链路（打包给别人用的关键）

```
electron-builder.yml files: [".agents/skills/**", ".agents/**"]
        ↓ 打包版 resources/app/.agents/skills（asar:false → 磁盘真目录，node 可读）
instrumentation.ts → ensureBuiltinSkillsSynced()
        ↓ cpSync 到 ~/.agents/skills/<name>（带 .pi-studio-bundled 标记）
pi 的 skill 发现：<会话 cwd>/[.pi|.agents]/skills + ~/.agents/skills   ← 任意项目都能加载
```

要点与坑：

- **`~/.pi/agent/skills` 是 pi 内部目录，不是 SDK 的全局技能目录**。想让终端用户在
  任何 cwd 都拿到技能，必须放 `~/.agents/skills`（`lib/bundled-skills.ts` 干的事）。
- **技能内不许用仓库相对路径调脚本**：会话 cwd 是用户自己的项目，
  `.agents/skills/ui-design/scripts/...` 在别人的项目里永远命不中。
  → `ensureAgentEnvExposed()` 额外导出 `PI_STUDIO_SKILLS_DIR`（app 内置权威副本）与
  `PI_STUDIO_USER_SKILLS_DIR`（同步后的全局副本）；`SKILL.md` 开头有一段「路径解析」要求先解析再调用。
- **子进程继承环境变量**：agent 的 bash 是本进程的子进程，所以 `PI_WEB_PORT` /
  `PI_STUDIO_SKILLS_DIR` 直接可读。打包版端口固定 10142、dev 10141（`electron/main.cjs:119`，
  固定是为了 localStorage 按 origin 隔离后 UI 设置不丢）。
- **同步策略保护用户**：目标存在但无 `.pi-studio-bundled` 标记 → 视为用户自有技能，永不覆盖；
  有标记则源 `SKILL.md` 更新时 `cpSync` 刷新。
- `impeccable`（v4.1.1）**未随包分发**：该 skill 无 LICENSE、无出处信息，再分发有授权风险。
  用户自行安装到 `~/.pi/agent/skills/` 或 `~/.agents/skills/` 时，
  `design-review.mjs --context` 会探测到并标注 `impeccable: available`，
  其 `context.mjs` / `concept-seed.mjs` / `reference/*.md` 可直接叠加使用；没装也不影响本流水线。

## 4. 静态自检 `static-check.mjs`（阶段 4 默认通道）

```bash
node "$SKILL_DIR/scripts/static-check.mjs" --files components,app --tokens app/globals.css [--json] [--strict]
```

- **多目录必须用逗号**（`--files app,components`）。写成空格分隔会被**静默忽略**，
  所以脚本现在遇到裸参数直接 exit=2，不默扫。
- 找不到 token 文件会**显式报错并跳过对比度检查**，不默不作声地交空结果。
- 退出码：0 = 无 P0；`--strict` 则有任何 finding 就非 0（可当门闸）。
- **算法已对账**：`--text-dim` on 玻璃实测底 `#cbd2db` 算出 **9.29:1**，
  与 `app/globals.css:50-51` 注释里五轮压深记录的 **9.3** 完全吻合——
  说明它可信，而且顺手纠了 `DESIGN.md` 里一处配错的历史数字（`#6B7280` 实为纯白 4.50 / 玻璃底 3.17，不是 3.88）。
- 透明色会先 alpha 合成到底色上再算（否则 `rgba(15,23,42,.10)` 这种会算出假高对比）。

## 5. `design-review.mjs`（可选增强，默认不走）

只在用户明确要「看图评审」且环境具备时才用（Electron 桥 + 支持图片的视觉模型）。

```bash
node "$SKILL_DIR/scripts/design-review.mjs" --context              # 探测 PRODUCT.md/DESIGN.md/impeccable，输出下一步
node ... --shot --out shot.png [--full-page] [--region css选择器] [--wait 800]
node ... --review --in shot.png [--model provider/modelId] [--region "设置弹窗"] [--max-chars 3000] [--no-retry] [--no-raise-budget]
node ... --selftest                                                # 不联网，自检技能资产与三层解析器
```

- **端口发现**：`PI_WEB_PORT` → 10141 → 10142 逐个探活
  （`GET /api/browser/control/health`，502 也算服务在），都探不到时告警回退 10141。
- **截图**：`GET /api/browser/control/screenshot?json=1[&full_page=true][&selector=…][&wait_ms=…]`
  → 桥返回 `{png_base64}`（`electron/bridge.cjs:1261`）→ 落盘。**仅 Electron 桌面模式可用**，
  纯 `dev` 浏览器模式返回 502，脚本给出兜底提示（headless 自行截图 或 `--source file --in x.png`）。
- **评审**：`POST /api/vision/describe`（`app/api/vision/describe/route.ts`），
  请求 `{text, images:[{type:"image",data,mimeType}], model?, maxTokens?, timeoutMs?}`，响应
  `{description, modelId, modelName, providerId}`。脚本把 **评审者角色约束 + rubric 全文 + DESIGN.md 节选**
  拼进 text（接口只有 `text`、**没有独立 system 通道**，所以角色必须写在正文头部），
  要求返回结构化 JSON（`findings[{id,severity,region,symptom,cause,fix,confidence}]` +
  `looks_like_generic_ai` + 五轴 `score`）。
- **上限**：单图 ≤ 10MB（`lib/image-attachments.ts` `MAX_ATTACHED_IMAGE_BYTES`），超限直接报错并提示只截目标区域。
- **必须裁到目标区域**：视觉模型在全屏截图里找不出 5px 级缺陷；`--region` 走桥的 selector 参数。
- **评审模型必须与生成方不同**：默认走「附属模型 → 视觉模型」（`lib/vision-model.ts` 解析顺序：
  显式选择 > 持久化 `pi-web-vision-model.json` > 自动扫描 input 含 image 的模型），
  它天然不同于当前主模型；也可 `--model provider/modelId` 强制。未配置视觉模型时接口返回 400 带中文指引。

### 输出预算为何可配

`route.ts` 默认 `max_tokens=2048`（为「描述图片」短输出设计），不够结构化评审用。
已新增**可选** `maxTokens` / `timeoutMs`（默认值不变，上限 8192 / 300s，聊天图片描述零回归）；
脚本默认请求 8192 + 200s（必须 < 本进程 `PROXY_TIMEOUT_MS=240s`），`--no-raise-budget` 可回退。

## 6. 外部方向种子（`direction-seed.mjs` + `reference/paradigm-bank.json`）

为什么不能只写进 SKILL.md：「必须交 6 个互斥方向」只是**要求**，拦不住模型的 argmax 惯性
（业界实测口径：同一模型 30/35 次交出相同概念，跨 16 种提问措辞不变）。
用户侧体验就是「生成 8 个方案，区别不大」。**随机性必须从外部注入。**

```bash
node "$SKILL_DIR/scripts/direction-seed.mjs" --count 6 [--domain tool|app|landing|docs] [--reroll 1] [--list]
```

- 输出：`must_avoid`（本品类那套 everyone-tuned-out 的默认构图）+ `assigned`（2 个**必答**非直觉范式）
  + `optional_pool`（其余候选）+ `rules`。每张卡给 axis / advance / density / layering / fits /
  **known_failure**，全部是「信息如何组织与推进」，**不含配色**——这就是「互斥」的坐标系。
- **稳定性**：种子 = `sha256(日期 | 项目根 | reroll)`。**项目根靠向上找 `.git`/`package.json` 定位**，
  不能用 `process.cwd()`（脚本可能从子目录被调用，否则同项目同日结果会飘）。
  同一天同一项目可复现，`--reroll n` 手动换一批。
- 卡池现有 **12 张范式 + 4 个品类默认构图**。加卡前先算 token：单卡≈140 token，整个输出会进上下文。
  `--count` 超过卡池容量直接报错退出，不默默交少数。
- 指派的方向**不许直接丢弃**：要么给出更优替代并说明理由，要么写出它在哪个真实场景下会赢。

## 7. Critic 模型选型（实测结论）

同一张 Pi Studio 真实界面截图、同一份 rubric + DESIGN.md 节选（以下为**降级前**的实测记录，保留作选型参考）：

| 模型 | 结果 | 原因 |
|---|---|---|
| `qwen-token-plan-individual/qwen3.8-flash`、`glm/glm-5.3-flash` | ✅ 直接返回**完整紧凑 JSON**（4 条 findings + 五轴 score + `looks_like_generic_ai`） | 不写长篇思考，预算够用 |
| `onmicro/kimi-k2.7-code` | ⚠️ 把 6000+ 字思考写进 `content`，JSON 刚开写就被削断；拉高预算后**网关 ~90s 自己 504** | 推理型输出 + provider 超时上限 |

**判据：结构化输出任务要挑「不把思考写进 content」的模型，能力高低是次要的。**
针对 kimi 这类模型已内置三层兜底（顺序固定，`--selftest` 全部断言）：
① `extractReviewJson`（要求 `findings` 为**非空数组**才算命中）→
② `salvageTruncatedJson`（从断尾 JSON 里按括号配平抢救已写完整的条目）→
③ `extractProseFindings`（散文：`F1: P1 region:…` / 无冒号变体 / 编号行 / markdown 列表加粗行）；
全部失败则自动**降级重试**（第 2 次回落到 provider 默认预算）。

> 历史坑：早期看到「`findings_source: json` 但 0 条」误以为是模型不吐 JSON，
> 实际是 `requestFindings` 返回字段叫 `parsed`、`modeReview` 却解构成了 `findings`。
> 教训：字段改名要同时改返回方与消费方，并让 selftest 跑**真实样本**而不只跑合成用例。

## 8. 迭代上限（别放开自转）

阶段 6 是**有界**的：批量评审一次 → 一次性修完 → 最多再验一轮 → 停。
只有同时满足「上一轮提出了**新**问题」且「该问题**可在当前项目内**落地修复」才允许第 2 轮；
否则停下，把未解决项写进报告交给用户。开放式自我打磨会在烧钱的同时做出更差的结果。
