---
name: sheet-edit
description: "编辑用户在 pi-studio 右侧打开/查看的表格（.univer/.xlsx 销售报表等）。选择本 skill 后，先读 pi-studio 数据目录下的打开文件标记（<项目>/pi-web-uploads/.internal/pi-web-open-file.json，或 GET /api/open-file）确定右侧打开的文件，然后直接对该文件执行：读取单元格、编辑数值/文本、条件格式、日期格式、删除行、工作区(worktree)创建/提交/合并/丢弃/删除、写回 .xlsx 原件、导出。Use when the user wants to edit the spreadsheet currently open in the pi-studio right panel (file recorded in the pi-studio open-file marker under <project>/pi-web-uploads/.internal/pi-web-open-file.json — resolve via GET /api/open-file) — read cells, change values, conditional formatting, date formats, row deletion, worktree lifecycle, write back to the original .xlsx, export. Built on the univer-cli skill (load `univer skills get core` + `univer skills get sheet` for the full CLI reference)."
---

# 编辑右侧打开的表格（sheet-edit）

本 skill 把「pi-studio 查看器 + univer-cli」的表格操作流程整理成一份可直接执行的清单。
目标是**用户右侧打开的表格**（查看器标记文件），无需用户再报文件名。

## ⚠️ 交付流程铁律（防止“几十轮问答”）

> 用户 2026-08-07 明确反馈：每个问题来回几十轮才解决。根因是**先交付后验证** + 若干工具语义坑。以下每条都是血泪教训：

1. **先验证、后交付**：任何一轮改动（改 .univer 或改查看器代码）完成后，必须走完：`tsc --noEmit` + `eslint` → headless 浏览器端到端实测 → 全部通过才向用户报告。**不要把“刚改完”的状态直接交给用户看**，那只会换来下一轮“没改/坏了”。
2. **文件数据 vs 查看器显示要分开判断**：用户报“没改”时，先 `univer export` + 读回验证文件真实数据；数据是对的 → 再查是不是查看器显示/缓存问题（见下）。不要一上来就怀疑数据被改坏。
3. **查看器解析结果按 scopeKey 缓存**（= 文件+工作区+headCommit；主干=mtime）。同一 headCommit 的改动不会重新解析。用户看到旧结果 = 缓存未失效。让用户看到新结果的两种办法：产生**新 commit**（headCommit 变 → 缓存 key 变），或让用户点查看器「刷新」按钮。
4. **切工作区/主干的双向实测**：涉及样式/结构的改动，必须实测 主干→工作区→主干 往返，断言样式精确还原。setValue 合并语义极易造成“切回主干样式残留”类 bug（见语义坑）。
5. **用户浏览器可能热加载滞后**：改完查看器代码后，用户浏览器可能还在跑旧 chunk（dev 编译需重新请求）。用新 commit 或提示刷新解决，别让用户看到旧代码的结果。
6. **写值必带类型（用户 2026-08-08 反馈：数据别全写成文本）**：批量写数据（报表/总结页/导入落库）时逐字段指定 `t`（数字 2 / 文本 1 / 强制文本 4）；百分比写**数字+`0.0%` 格式**、日期写**序列号+`yyyy-MM-dd` 格式**，禁止把 `"74.6%"`、`"2026-07-21"` 这类整片写成文本字符串——否则 Excel/查看器出绿三角、无法计算排序，还得二次修复。详见「常用编辑脚本模板」的写值类型铁律。

## 第 0 步：确定目标文件（必做）

```bash
cat <项目根>/pi-web-uploads/.internal/pi-web-open-file.json   # {"filePath":"C:/.../hello.univer","updatedAt":...}
```

- `filePath` 就是用户右侧正在查看的表格（.univer 或 .xlsx）。
- 标记文件不存在或路径为空 → 问用户要编辑哪个文件。
- **约定**：用户说「编辑表格/报表/这个表」且未点名文件时，默认就是标记文件。

## 第 1 步：侦察（动手前先看清楚）

```bash
univer status <file> --json                 # 拿 unitId（顶层 Unit，通常是 sheet）
univer worktree list <file>                 # 工作区一览（draft/ready/merged/discarded）
univer export <file> /tmp/probe.xlsx --unit <unitId> --formula-calculation forced
```

导出后用 node + xlsx 解析看结构（sheet 名、表头、行列范围、单元格值）：

```bash
node -e "const XLSX=require('xlsx');const wb=XLSX.readFile('/tmp/probe.xlsx');console.log(wb.SheetNames);const ws=wb.Sheets[wb.SheetNames[0]];console.log(XLSX.utils.sheet_to_json(ws,{header:1}).slice(0,12));"
```

> Windows 注意：Node 里 `/tmp` 解析为 `C:\tmp`（可能 ENOENT），用项目内相对路径或 `C:/Users/.../AppData/Local/Temp`。

## 第 2 步：选择编辑路径

### 路径 A —— 让用户在 pi-studio 查看器里直接编辑（推荐给「内容微调」）
- 用户在右侧查看器改单元格，**停顿约 2 秒自动保存**：
  - 选 trunk 时 → 自动提交进主干（显示「已自动保存到主干（uN）」）
  - 选工作区时 → 自动提交到该工作区（u{seq} 蓝色标识）
- agent 的角色：等用户改完 → 检查工作区提交（`univer worktree log`）→ 让用户点「合并到主干」。

### 路径 B —— agent 直接编辑（推荐给「按指令批量改」）
核心是**不能在 trunk 上直接写**，必须走「临时工作区 → execute → ready → **用户自己合并**」：

```bash
# 1) 建临时工作区（名字随意，如 edit-<时间戳>）
univer worktree add <file> --name edit-<stamp>        # 输出 created worktree wt-xxxx
# 2) 写脚本（用文件传，避免 Windows 命令行长度限制）
univer execute <file> --worktree wt-xxxx --unit <unitId> --script /path/edit.mjs   # 自动提交
# 3) 读回验证（导出该工作区）
univer export <file> /tmp/verify.xlsx --worktree wt-xxxx --formula-calculation forced
# 4) 就绪后停下，绝不自己 merge：
univer worktree ready <file> --worktree wt-xxxx
#    ✅ 到此为止。告诉用户「已就绪，请在右侧查看器点『合并到主干』」
#    ❌ 禁止：univer worktree merge（除非用户明确说「合并」）
```

> ⚠️ **铁律（用户 2026-08-07 明确要求）：agent 编辑完只标记 ready，绝不自动 merge。**
> 用户要自己在查看器点「合并到主干」，或明确说「合并」后 agent 才执行 `worktree merge`。
> 任何情况下都不以「这是 trunk 编辑任务」为由自动合并。

> **工作区复用规则（用户 2026-08-07 反馈：每个问题一个新工作区太碎）：**
> 同一轮对话中连续的小改动（如连续几个格式调整）应**复用同一个草稿/待合并工作区**，
> 用 `univer worktree reopen` + execute 追加，直到用户合并或明确开启新任务才新建工作区。
> 避免每问一个就产生一个待合并工作区。只有以下情况才新建：
> - 上一个工作区已 merged/discarded（终态不可复用）；
> - 用户明确说这是新任务/新文件范围；
> - 改动方向冲突（如一个改格式、另一个改结构且用户想分开审批）。

> **工作区只读编辑规则（用户 2026-08-08 明确要求：编辑只能工作区编辑）：**
> pi-studio 查看器的在线编辑**不再写入主干**——edit-commit 服务端拒绝 trunk（400），
> 查看器在 trunk 视图下首次编辑会自动创建草稿工作区（`编辑-<HH:mm>`）并切入，
> 后续保存复用该工作区（`autoWorktreeRef`）。主干内容只在用户点「合并到主干」后变化。
> agent 用 CLI 操作时同样**只写工作区**，绝不直接改 trunk。

> 分支编辑（用户已有「编辑中」工作区）时：直接用现有工作区执行 execute，不要新建。

## 常用编辑脚本模板（全部实测可用）

### ⚠️ 写值类型铁律（2026-08-08 用户反馈：数据别全写成文本）

**写每个单元格前先定数据类型，显式写 `t`；禁止写裸值或"看起来对"的字符串。** 生成报表/总结/批量数据页时最容易整片写成文本——逐字段判断类型再写。

| 数据 | 正确写法 | 错误写法（后果） |
|---|---|---|
| 数字 | `{ v: 88888, t: 2 }` | `{ v: "88888", t: 1 }` 文本，无法计算/排序 |
| 文本 | `{ v: "部门", t: 1 }` | 裸 `"部门"`（无 t） |
| 编号/料号/BPM单号 | `{ v: "00123", t: 4 }` 强制文本 | `{ v: 123, t: 2 }` 丢前导零 |
| 百分比 | `{ v: 0.746, t: 2, s: { n: { pattern: "0.0%" } } }` | `{ v: "74.6%", t: 1 }` → Excel 绿三角 |
| 日期 | `{ v: 46224, t: 2, s: { n: { pattern: "yyyy-MM-dd" } } }`（序列号 = `Date.UTC(y,m-1,d)/86400000 + 25569`） | `{ v: "2026-07-21", t: 1 }` → Excel 绿三角 |
| 布尔 | `{ v: true, t: 3 }` | — |

**侦察提速（2026-08-08 复盘，总耗时 5min→目标 2min）**：
- **统计一次跑完**：结构+状态+厂商+工艺+层数+交期+需关注+脏数据合并进**一个 node 脚本**（读一次 xlsx 全算完），别分 5-6 轮；日期格式化用**本地时区**（`d.getFullYear()/getMonth()/getDate()`），`toISOString()` 是 UTC 会偏移一天
- **重复项目名是常态**（追踪表同名多批次，OM9578-11 有 29 行）：统计按「项目名→次数」维度，读回验证别用 `find()` 取首行，要带行号/状态定位

**真实踩坑**：总结页把占比/期望交期全写成文本字符串，Excel/查看器单元格左上角出现绿色三角（「数字以文本形式存储」），还要二次 execute 改成数值+格式才消失。验证类型用 `univer inspect range <range> <file> --unit <id> --worktree <id> --json` 看 `t`（2=数字 1=文本）和 `displayValue`（确认格式渲染正确）；格式 pattern 用 execute + `workbook.save().styles[样式ID].n.pattern` 读。

**univer-ops write op**：单格/ grid 写值时数字自动推断 `t:2`，但**字符串一律 `t:1`**——百分比/日期这类要传**对象值** `{ v, t, s: { n: { pattern } } }`（grid 里 `typeof v === "object"` 会透传），或改用专门的 `percent` op（支持 `percentPattern` 参数）；编号类记得 `t: 4`。

`getRange(r,c,1,1)` 是 **0 起始**（r=0 是第一行，c=0 是 A 列）。值类型 t：1=字符串 2=数字 3=布尔 4=强制文本。

### 建新 sheet / 总结页配方（2026-08-08 实测，API 全签名在此，别再 api find/show）

```js
// 建 sheet（返回 FWorksheet，成为活动页）：同名先删再建
const sh = workbook.create('进度总结', 150, 26);   // create(name, rows, cols)
// 删除旧：workbook.deleteSheet(workbook.getSheetByName('进度总结'))

// 写格 helper：R 从 0 开始！（R=1 会把第一行留空，导出后才发现返工过）
function put(r, c, v, t, s) { sh.getRange(r, c, 1, 1).setValue({ v, t, ...(s ? { s } : {}) }); }

// 样式对象 s（实测字段）：bl 加粗 / fs 字号 / bg 背景 {rgb} / cl 字色 {rgb}
//   标题深蓝 #1F4E79 底白字 fs16；区块标题 #DDEBF7 底 #1F4E79 字 fs12；表头 #F2F2F2 底加粗
//   风险红字 #C00000；警示黄字 #BF8F00；注释灰字 #595959 fs10

// 尺寸约定：sh.setRowCount(150) + sh.setColumnCount(26)
```

**验证（分级，别 export）**：
- 结构（建 sheet/尺寸/sheet 列表）：`univer inspect workbook <file> --unit <id> [--worktree <id>] --json`，2 秒，勿 export 读回
- 值/类型/格式渲染：`univer inspect range '<sheet>!A1:C9' <file> --unit <id> --worktree <id> --json` 看 `t`/`displayValue`
- **样式：execute + `workbook.save()`**——`cellData[r][c].s` 是**样式 ID 字符串**，真样式读 `save().styles[样式ID]`（如 `{ bl, fs, bg: { rgb }, cl: { rgb } }`）。⚠️ `FRange.getCellData()` 在此环境不返回 `s`，别用它读样式（踩过 4 轮 execute 的坑）

```js
// 写一个数字（如 C5 即 r=4,c=2 设为 88888）
workbook.getActiveSheet().getRange(4,2,1,1).setValue({ v: 88888, t: 2 });

// 写文本
workbook.getActiveSheet().getRange(0,0,1,1).setValue({ v: "部门", t: 1 });

// 清空单元格（彻底，含格式/公式）
workbook.getActiveSheet().getRange(2,1,1,1).setValue({ v: null, f: null, p: null, si: null, custom: null });

// 改公式
workbook.getActiveSheet().getRange(9,2,1,1).setValue({ f: "SUM(C3:C8)", v: null });
```

批量多单元格时把多条语句拼进同一个脚本文件，`execute` 一次提交全部。

### 数据验证 DV 常见坑（2026-08-08 实测）

- **univer-ops 的 `range` 必须完整 A1 格式 `'N2:N423'`**：写成 `'N2:423'` 会被 `getRange` **静默**解析成 `N2:A423`（结束列变 A 列，覆盖整行），不报错但范围错误——生成 range 时用 `col+'2:'+col+'423'` 拼，不要省结束列字母。
- **清除已有 DV**：对覆盖范围 `getRange('A1:AE423').setDataValidation(null)` 可整表清除（生成 `data-validation.mutation.removeRule`）；同 range 直接 `setDataValidation(新规则)` 会拆分旧规则，不可靠。
- **验证生效 DV 以 export XML 为准**：`unzip -p out.xlsx xl/worksheets/sheetN.xml | grep dataValidation` 看 `type`/`sqref`/`formula1`（权威，一次 ~20s）；`verify-univer-changes.mjs` 只统计 `addRule` **不统计 `removeRule`**，删除场景会误报——先 addRule 后 removeRule 时它显示的数量是增量总数而非生效数。
- 下拉一律内联 `requireValueInList`（≤255 字符 Excel 兼容）；日期用 `requireDateBetween(start, end)` + allowBlank/allowInvalid。

### 条件格式（CF）—— 用 Facade builder，别手拼 XML

```js
import { newConditionalFormattingRule } from "@univerjs/sheets-conditional-formatting";
import { preset } from "@univerjs/presets"; // 或按安装版本引入

// 例：C3:C8 数值 > 100000 标红底
const rule = newConditionalFormattingRule()
  .whenNumberGreaterThan(100000)
  .setBackground("#FF0000")
  .setRanges([range.getRange()])   // 注意是数组
  .build();
```

（按 `univer skills get sheet` 给出的当前版本 Facade 写法为准。）

### 下拉数据验证 + 按值配色（已实测，2026-08-07）

**现成脚本**：`.agents/skills/sheet-edit/scripts/vendor-dropdown-cf.mjs`（自包含，一次 execute 完成
「某列去重列表 → 每 sheet 下拉验证 → 按值配 42 色」）。改顶部 `TARGET_COL`/`HEADER_TEXT` 即可换列。

### 通用操作脚本库 univer-ops.mjs（2026-08-08 新增，任意表格同套操作）

用户洞察：上传的表格都不同、内容不同，**只有操作是相同的**。`.agents/skills/sheet-edit/scripts/univer-ops.mjs`
把常用操作参数化，一次 execute 完成多步：`read / write(值,grid) / formula / clear / style(背景,加粗,颜色,对齐,数字格式) /
merge(合并/取消) / rows(插入/删除) / dropdown(内联LIST) / dropdownFromColumn(按列去重) / cf(数值比较) /
cfText(按值配色) / dims(行列数)`。

用法（agent 生成临时脚本，ops JSON 内联到 `__OPS__` 占位符——execute 环境不支持顶层 import，
Windows .cmd shim 会丢环境变量，所以统一模板内联）：

```js
const tmpl = fs.readFileSync('.agents/skills/sheet-edit/scripts/univer-ops.mjs', 'utf8');
fs.writeFileSync(tempPath, tmpl.replaceAll('__OPS__', JSON.stringify(opsArray)));
// univer execute <file> --worktree <wt> --unit <id> --script tempPath --json
```

约定：range 用 A1 风格（1 起始）；`merge:false` 取消合并走 `univerAPI.executeCommand(
"sheet.command.remove-worksheet-merge", { unitId: workbook.getId(), subUnitId: sheet.getSheetId(), ranges })`
（FRange 无 unmerge）；CF 规则用 `parseA1` 的行列字面量（FRange 无 getStartRow）。
已实测：写值/网格/公式/样式/合并(取消+重合并)/下拉/按值配色/读/dims 10 个 op 一次 execute 全过（hello 文件 3-5s）。

手写 API（execute 环境已验证）：

```js
// 下拉验证：LIST + 允许空白/允许列表外值
const dv = univerAPI.newDataValidation()
  .requireValueInList(vendors)                    // string[]，按频率降序最顺手
  .setAllowBlank(true)
  .setAllowInvalid(true)
  .setOptions({ showDropDown: true, showErrorMessage: true })
  .build();
sheet.getRange(2, 1, lastRow - 1, 1).setDataValidation(dv);  // B3:B末行

// 按值配色：每个值一条 whenTextEqualTo 规则（同一值跨 sheet 用同一色）
const rule = sheet.newConditionalFormattingRule()
  .whenTextEqualTo(vendor)
  .setBackground(color)   // xlsx 安全色 #RRGGBB
  .setRanges([{ startRow: 2, endRow: lastRow, startColumn: 1, endColumn: 1 }])
  .build();
sheet.addConditionalFormattingRule(rule);
// 替换旧规则：遍历 getConditionalFormattingRules()，range 命中本列时 deleteConditionalFormattingRule(cfId)
```

**配色方案（避免相邻同色）**：等距色相 + 明度交错 —— `hsl(i*360/N, 65, i%2?62:84)`，
相邻值 RGB 距离 96-131（旧黄金角 `i*137.5, s50, l85` 相邻值仅差 1-4，肉眼几乎同色，勿用）。

**Excel 兼容（踩坑结论）**：
- 内联 LIST 拼串 ≤255 字符 → Excel 正常；>255（如 42 家厂商拼 272 字符）→ 查看器正常，但 xlsx 写回后 Excel 下拉可能截断。
- 范围引用（`requireValueInRange`）更糟：当前 Univer 导出为 `'[unitId]表!A1:A3'` 的 Excel 无法解析格式，勿用。
- 隐藏 sheet 隐藏列本身导出正常，但配范围引用 DV 无意义。
- 结论：**一律用内联 `requireValueInList`，超长只提示用户写回 Excel 时的限制**。

### 插入行 / 设置 sheet 尺寸（用户约定 2026-08-07）

- **插入数据行**：`sheet.insertRows(rowIndex, numRows)`（在 rowIndex 处插入 numRows 个空行，后续行自动下移）——插入到合计行之前时合计行会自动下移；合计若原来是硬编码值要**重算**（原表硬编码合计 529800 其实是错的，真实和是 556377，别沿用）。
- **sheet 默认尺寸约定：最大行 150、最大列 26（A-Z）**——用户明确要求所有表格按此设置：`sheet.setRowCount(150)` + `sheet.setColumnCount(26)`（对当前 sheet 生效，同文件其他 sheet 也会跟着变，属预期）。
- **尺寸在 .univer 里存得住，但 xlsx 导出会丢**（xlsx 没有固定网格尺寸，只有数据范围）——验证用 `univer inspect workbook <file> --unit <id> [--worktree <id>] --json` 看 `maxRow/maxColumn`（这才是权威），别用 xlsx 读回判断。查看器已通过 `/api/univer/view` 的 `X-Univer-Sheet-Dims` 响应头（URL 编码 JSON，含中文 sheet 名必须 encodeURIComponent）恢复网格尺寸。
- 公式缓存坑：`setValue({ f: ..., v: 计算值 })` 的 v 会被计算引擎清零（导出显示 0）——要么用公式配方（先 `onCalculationResultApplied()` 再 await），要么直接写硬编码值（与原表风格一致）；`{ v, s }` 合并写入会保留旧公式，可借这个特性"公式 + 正确缓存值"两全。

### 日期列：数字序号 + 显式格式

Excel 日期是「从 1900-01-00 起的天数（含小数=时分秒）」：

```js
// 45301.000497685185 = 2024-01-15 00:00:43；设置格式显示 时分秒
workbook.getActiveSheet().getRange(4,4,1,1).setValue({ v: 45301.000497685185, t: 2, s: { n: { pattern: "yyyy-MM-dd hh:mm:ss" } } });
```

### 删除整行 / 合并单元格等结构操作

用 Facade：`getRange(...).delete()` / `getMerges()` 等 —— 以 `univer skills get sheet` 的 API 为准。
> 注意：**查看器在线编辑只捕获单元格 v/t/f 的改动**；样式、合并、行列增删不会被自动保存捕获，这类操作要用路径 B（agent execute）完成。

## 工作区生命周期速查

```bash
univer worktree add <file> --name <n>                  # 新建（默认名 u-6位随机数，查看器 + 按钮也用这个）
univer worktree list <file>                            # 列表（--json 可解析）
univer worktree log <file> --worktree <id>             # 提交历史（#N = seq）
univer worktree ready <file> --worktree <id>           # 标记待合并
univer worktree merge <file> --worktree <id>           # 合并进主干（用户确认后）
univer worktree discard <file> --worktree <id>         # 丢弃（保留记录）
univer worktree rollback <file> --worktree <id>        # 回滚最新一条提交（LIFO）
```

- **删除工作区记录**：CLI 没有 delete 命令 → 用 pi-studio 的 `POST /api/univer/worktree-delete`（body `{file, worktree}`），**已合并的不能删**。
- 工作区名字 `pi-auto-*` 是查看器主干自动保存的隐藏暂存区，**不要动它们**。
- 提交标记：查看器在线编辑 = `u{seq}`；CLI/agent 提交 = `r{seq}`。

## 写回原件 / 导出

- **写回 .xlsx 原件**（用户把 .univer 内容覆盖回同名 xlsx）：
  `POST /api/univer/writeback` body `{file: "<path.univer>"}` → 覆盖同目录同名 `.xlsx`，无需备份。
- **导出下载**：`univer export <file> <out.xlsx|csv> [--worktree <id>] [--sheet <sheetName>] --formula-calculation forced`（CSV 需指定 sheet 名）。
- 导出后务必读回核对（数值、CF 是否仍在）。

## 验证（不能只看命令成功）

### ⏱ 验证分级（2026-08-08，总耗时 10 分钟 → 目标 1 分钟内）

**铁律：区分验证级别，别什么都 export + headless——那是 10 分钟任务的主因。**

| 改动类型 | 验证方式（按成本从低到高） | 耗时 |
|---|---|---|
| 值/类型/格式（write/normalize/fixTextNumbers/dropdown/dateValidation） | **execute 返回值计数即权威**（如 fixTextNumbers 返回 `percents:47`）+ `verify-univer-changes.mjs`（SQLite 直读 <1s） | <1s |
| CF/DV 增量 | `verify-univer-changes.mjs` SQLite changesets 直读 | <1s |
| 结构（createSheet/deleteSheet/dims/列宽） | `univer inspect workbook`（SQLite 直读）看 sheet 列表/尺寸/range | 2s |
| Excel 兼容格式（需确认 XML 写法） | 一次 export + unzip grep（最后才做，且只做一次） | 20-30s |
| 查看器代码改动 | tsc + eslint + **headless-smoke 一次**（最后跑，预热 dev 页面） | ~2-3min |

**流程纪律（从 4 分钟/10 分钟任务复盘）**：
1. **一次 execute 做完所有改动**，别分轮（每轮 30-60s 是 daemon 握手，不只执行时间）。
2. **不要反复 export**——只有需要确认 Excel XML 写法时才 export 一次；值类改动用 execute 返回值 + SQLite 直读。
3. **headless 冒烟只跑一次、且作为最后一步**；跑之前先自查断言逻辑（脚本里断言写错会白跑 2-3 分钟）。
4. **扫描/读回脚本输出标准 A1 地址**（`scripts/scan-text-numbers.mjs`），别用 `R58CE` 这类歧义列名（曾把 E 列看成 AE 列，白跑一轮 execute）。
5. **daemon 预热**：连续任务时先跑一次 `univer status` 拉起 daemon，后续 execute 握手更快。

**Headless 冒烟脚本**：`scripts/headless-smoke.mjs`（打开查看器 → 切工作区 → 断言单元格类型/值）。

## 验证（旧节选，保留兼容）

1. **读回**：export → node+xlsx 断言关键单元格值/公式/格式。
2. **条件格式/视觉**：无头 Chrome 打开 pi-studio 查看器 → CDP 截图 → 像素检查红色等；或 CLI 自带 viewer（端口 9123）。
3. 数值类改动两个都查；只查 `univer status` 输出不算验证。

### 验证速度/准确性优化（2026-08-07 实测，总耗时从 20+ 分钟压到 ~2 分钟）

- **DV/CF 增量验证走 SQLite changesets 直读（2026-08-08 新增，40-60s → <1s）**：
  `.agents/skills/sheet-edit/scripts/verify-univer-changes.mjs` 直接读 .univer 的
  `collaboration_worktree_changesets`，统计 execute 提交的 DV（`data-validation.mutation.addRule`，
  `rule.formula1` 即内联 LIST）与 CF（`sheet.mutation.add-conditional-rule`）增量——与 execute 返回完全一致，
  不需要 export 解包。用法：`node verify-univer-changes.mjs <file.univer> <worktreeId>`。
  注意：DV/CF 的 `subUnitId` 是 uni1-uni5 这种内部 id，脚本按 sheetOrder 顺序对应。
- **查看器 view 缓存预热（2026-08-08）**：edit-commit 提交后后台 `warmViewScope()` 预热
  `/api/univer/view` 的导出缓存（`lib/univer-view-cache.ts`），用户编辑完立即切查看器只需 2-3s
  （否则首次导出 23s）；dims（maxRow/maxColumn）改 SQLite 直读（`lib/univer-dims.ts`），
  不再每次 `univer inspect workbook`（省 8s）。

- **导出 XML 是 DV/CF 的权威证据**：`unzip -p out.xlsx xl/worksheets/sheetN.xml | grep dataValidation/cfRule` +
  `styles.xml` 的 dxf 填色。一次 export（~20s）+ 一次解包 grep 就够，**不要反复 export**（16MB 文件每次 40-60s）。
- **截图像素取证只用于「外观必须确认」**，且抓极小范围（如 A61:B66 单厂商行），采样已知列位置（x≈13-14% 宽度），
  容忍度 ±12（渲染器有色偏，如存储 rgb(188,241,188) 渲染成 rgb(198,236,201)）。截图布局坑：暗色主题下空列是黑色、
  左侧有行号槽（灰色）、capture 会含范围外行列；先横向扫描定位列边界再采样，别凭 x 坐标猜。
- **改完一次性验证**：所有编辑合并进一次 execute（多语句脚本），验证只做一遍，不要改一步验一步。
- **daemon 竞态**：execute/export 报 SIGTERM / Runner exited before ready 是冷启动竞态，重试一次即自愈（先 `univer daemon stop` 再重试更稳）；内联 `-e` 读回不稳时改走 export 验证。
- **API 发现是重复成本**：DV/CF 接口见上文「下拉数据验证 + 按值配色」，别再 api find/show。

## 常见坑（本工作流实测总结）

### 环境/工具坑（Windows 实测）

- Windows 下用 node 调 CLI 必须 `shell:true`（univer 是 .cmd shim）。
- **`univer execute --script` 必须绝对路径**（如 `C:/.../edit.mjs`）；相对路径报 `error: Runner exited before ready`。
- Node 里 `/tmp` 解析为 `C:\tmp`（可能 ENOENT）；测试文件放项目内或用 `C:/Users/.../AppData/Local/Temp`。
- **univer CLI daemon**（`internal/daemon.js serve` 常驻进程）：所有 `execute/export` 由它服务，命令需在启动超时内完成握手。报 `error: Runner exited before ready` / `Daemon process exited before startup completed` 的**真实根因是 daemon 启动竞态**：没有存活 daemon 时（冷启动、刚 kill/stop 后），并发/紧随的 CLI 调用互相争抢启动 daemon，输家报错，且可能留下多个 daemon 互相干扰——**重试一次即可自愈**（单条命令会拉起一个干净 daemon）。优雅处理：`univer daemon stop` 后重试。CLI 自己的恢复提示就是“停掉旧 daemon、清 stale runtime 文件、重试”。
- **pi-studio 已把 univer-cli 内置为项目依赖 + 独立 daemon**（2026-08-08）：`package.json` 有 `univer-cli`；pi-studio 所有 CLI 调用（`lib/univer-cli.ts`）通过 `UNIVER_HOME=<项目>/pi-web-uploads/.internal/univer` 跑**自己的 daemon**，与终端全局 CLI 的 `~/.univer` daemon 完全隔离（两者 insiders 依赖解析不同 → 构建哈希不同，共享 root 会报 `Daemon build mismatch`）。agent 在终端用全局 CLI 操作同一 .univer 文件没问题（daemon 只做会话服务，写 SQLite 的是命令进程本身）。
- **`--script` 路径**：绝对**正斜杠**路径（`C:/...`）最稳；相对路径只要文件存在于 cwd 也能用（早前“相对路径报错”实为上述 daemon 竞态，不是路径问题）；**绝对反斜杠路径会被 cmd 吞掉反斜杠**（路径拼接错乱报 ENOENT），勿用。导出目标路径同样建议相对路径或正斜杠。
- **daemon 锁文件**：它持有最近访问的 .univer 文件**不释放**（实测 60s+ 仍锁），删测试副本报 `Device or resource busy` → `univer daemon stop` 后立即解锁再删。测试副本用完即删，别留垃圾文件在项目里。
- **dev server 端口**：`package.json` 的 dev script 是 **10141**（AGENTS.md 旧文档写 30141）。两个端口都可能被旧 `next start` 占着（生产 bundle，新代码全部 404）——动手前先 curl 探测 `http://localhost:10141/api/open-file` 等现有路由，找到真正活的 dev server。
- 验证/测试脚本别放项目根目录（会污染 `eslint`，报 require 错误）；放系统 Temp，`require` 项目内包（如 ws）用绝对路径。
- 长脚本用 `--script <path>` 传文件；`-e` 内联只适合短语句。
- `execute` 强制要求 `--worktree` + `--unit`；**trunk 写入只有 staging worktree + merge 一条路**。
- `import --file x.xlsx --worktree` 只会**新增单元**，不能替换已有内容。

### Univer Facade / 查看器语义（非代码逻辑，踩过坑）

- **`setValue` 是合并语义**：不传 `s` → 保留旧样式；`s:{}` → 也保留；**只有 `s:null` 能清除样式**。样式对象是**逐字段深合并**——目标样式是子集时旧字段（如 ht/vt）残留。要换/删样式必须两步：先 `setValue({..., s: null})` 再 `setValue({ s: 目标样式 })`。
- **`getCellData().s` 返回样式 ID 字符串**（如 `"ELZ_Zv"`），真实样式查 `wb.save().styles[id]`。别把 ID 当样式对象读。
- **SheetJS CE 读 xlsx 丢 alignment**（只带 fill）；`XLSX.readFile(f, { cellStyles: true })` 才能看到样式。样式验证别只信 SheetJS 读回——解压 xlsx 看 sheet XML 的 `<alignment>`，或直接看查看器渲染。
- **日期格式单元格**（cell.z 是 y/m/d/h/s 格式）：样式必须「numFmt 与 bg/align 合并」而不是覆盖，否则背景丢失（表头挂着旧日期格式时最容易踩）。
- SheetJS CE 丢 conditionalFormatting/validations/autoFilter（查看器内部用 fflate 解析 XML 补回；agent 导出读回时别拿它当 CF 的权威证据）。
- 查看器暴露 `window.__piUniver`（FUniver）调试钩子；headless 验证用它读 `save()` 模型断言值/样式。
- **绿三角「数字以文本形式存储」提示的中文依赖 `components/XlsxViewer.tsx` 的 locale 补丁（1073 行）**：Univer 提示文案 key 是 `sheets-numfmt-ui.info.error` / `info.forceStringInfo`，而 preset-sheets-core 的 zh-CN **缺这两个键**（`grep forceStringInfo node_modules/@univerjs/preset-sheets-core/lib/locales/zh-CN.js` = 0），所以 XlsxViewer 在 `locales.zhCN` 里显式补齐 `"sheets-numfmt-ui": { info: { error: "错误", forceStringInfo: "以文本形式存储的数字" } }`。
  - 用户报“提示显示英文/接口名”时：**先查数据层**（该列是不是文本数字——文本数字才是绿三角根因，normalize 转真数字后绿三角直接消失），**再提示刷新浏览器**（旧 chunk 会显示英文/缺 key，Ctrl+F5 解决）；代码本身通常没问题，**不要删/改这段补丁**。
  - 排查链：数据层 = `univer export` + 读回看该列类型；文案层 = Univer es/index.js 里 `t("sheets-numfmt-ui.info.forceStringInfo")` 的调用点 + preset zh-CN 是否含该键。

### 无头浏览器（CDP）验证要点

- headless Chrome 必须 `--disable-extensions` 且**把 URL 直接作为启动参数**（about:blank + Page.navigate 会被扩展劫持跳走）。
- CDP `Runtime.evaluate` 的 `returnByValue: true` 不能序列化复杂对象（Univer 实例报 `Object reference chain is too long`）——用 `(() => ...)()` 包裹只返回原始值；要比较实例是否重建，用 `window.__marker = window.__piUniver` 存引用再 `window.__marker === window.__piUniver`。
- 样式断言：`wb.save().styles[id]` 拿真实样式（bg/ht/vt/n）；切换/还原断言要测完整往返。
- 若改动涉及 pi-studio 查看器自身代码：改完必须 `tsc --noEmit` + `eslint` 通过，且别跑 `next build`。
