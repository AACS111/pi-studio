---
name: office-edit
description: "创建/编辑 .univer 办公文件的多单元内容：文档(doc)、幻灯片(slide)、多维表(base)、画板(board)、UML/示意图；导入 .docx/.pptx/.csv，导出交付。用于「写个文档/PPT、做个客户跟踪库、画流程图/架构图/UML 类图」类任务。表格(sheet)编辑仍走 sheet-edit skill；本 skill 只覆盖非 sheet 单元。"
---

# Office 多单元编辑（doc / slide / base / board）

所有操作通过 `univer` CLI（项目内 pinned 版本，pi-studio 后端已托管 daemon）。
底层契约见 univer-cli skill：先 `univer skills get core`，再按单元类型
`univer skills get doc|slide|base|board` 获取该类型的完整 Facade 配方。

## 核心模型

> 命令约定：文中所有 `univer ...` 示例在打包版/无 PATH 环境下等价写法为
> `node "$UNIVER_CLI" ...`（pi-studio 启动时注入 CLI 绝对路径；开发版也可直接用
> `node node_modules/univer-cli/bin/univer.js`）。所有操作设 `UNIVER_HOME` 指向
> pi-studio 数据目录的守护进程（见第 0 步）。

- `.univer` 文件可含多个顶级 Unit（Sheet/Doc/Slide/Base/Board），用 `unitId` 寻址：
  ```bash
  univer unit list <file.univer> --json                 # 看现有单元
  univer unit add <file.univer> --type doc --name "周报" # 需在 worktree 内加单元时加 --worktree <id>
  ```
- 写入一律走 worktree：`univer worktree add` → `univer execute --worktree --unit -e '<js>'`
  → 让用户审阅合并（永不直接改 trunk）。execute 自动 commit，prelude 已绑定根对象：
  sheet=`workbook`、doc=`doc`、slide=`presentation`、board=`board`（base 用 `univerAPI.getBase(unitId)`）。
- 改完必须验证：`univer inspect` 读回 + `univer screenshot <file> --worktree <id>` 出 PNG 证据。

## 各类型最小配方

```bash
# 文档 Doc
univer execute f.univer --worktree W --unit U -e 'doc.appendParagraph("标题");'
# 幻灯片 Slide（页面、形状、文本）
univer execute f.univer --worktree W --unit U -e 'const s=await presentation.appendSlide(); const sh=s.insertShape({shapeType:api.Enum.ShapeTypeEnum.RoundRect,transform:{left:80,top:80,width:220,height:110}}); sh.getText().setText("标题");'
# 多维表 Base（表/字段/记录）
univer execute f.univer --worktree W --unit U -e 'const b=univerAPI.getBase("UNITID"); b.insertTable("客户", {fields:[{displayName:"公司"},{displayName:"阶段"}]});'
# 画板 Board（节点+正交连线，适合架构图/流程图）
univer execute f.univer --worktree W --unit U -e 'const a=board.insertShape({shapeType:api.Enum.ShapeTypeEnum.RoundRect,transform:{left:80,top:80,width:180,height:90}}); a.getText().setText("开始");'
```

精确 API 离线查证：`univer api show FDoc FSlide FBoard FBase` / `univer api find <keyword>`。

## 幻灯片快速成册（新建/修改 PPT 必走）

> 🚨 **铁律：永不自动合并 worktree。**

> Agent 只负责：`worktree add` → 编辑/`compile` → lint 清零 → `worktree ready` → 推右侧，**到此停手**。
> **`worktree merge`（合并到主干）是用户在右侧查看器手动触发的动作，Agent 绝对不得代为执行。**
> 多次编辑若需预合并，同样只 `ready`，等用户确认。

**先开右侧再动手**：凡是要修改的 .univer 文件，先推右侧（open-file-request，见文末）让用户
看着实时状态再编辑；合并主干后查看器检测到 trunk 变化会自动重载，无需重复推送。

### 第 0 步：环境与脚手架（一次搞定，不要分多次调用）

输出位置：**当前项目根（会话工作目录）**——生成的 .univer 与导出的 .pptx 都放在这里
（如 `<项目根>/新PPT.univer`），用户在项目里直接可见、可继续编辑。**不要放数据目录**。

数据目录（读项目根 `.pi-web-config.json` 的 `uploadsDir`，未配置默认 `<项目>/pi-web-uploads`；
打包版为系统数据目录）只承载三样内部产物，均不进用户项目：① UNIVER_HOME 守护进程、
② svg 中间稿工作目录、③ open-request 推送标记。

```bash
export UNIVER_HOME="<数据目录>/.internal/univer"   # 默认 ~/.univer 是另一套守护进程
node "$UNIVER_CLI" --version   # pi-studio 注入的 CLI 绝对路径（打包版/开发版都有效）；等价于 node node_modules/univer-cli/bin/univer.js
node "$UNIVER_CLI" new "<项目根>/新PPT.univer" --json
W=$(node "$UNIVER_CLI" worktree add "...univer" --json | 取 worktreeId)
U=$(node "$UNIVER_CLI" unit add "...univer" --type slide --name 标题 --worktree $W --json | 取 unitId)
```

### 第 1 步：复制骨架脚本，按主题生成内容（禁止从零手写基础设施、禁止逐页手写完整 SVG）

skill 目录自带 **gen.skeleton.mjs**——只含每个 PPT 都需要的基础设施：画布/字体/转义、
原子组件（svg/text/rect/pill/pageHead）、分页输出循环；**不含任何主题内容**：
配色、版式、页面函数、页数全部由本次主题决定（不一定是 6 页，按内容定）。

1. 复制到工作目录：`<数据目录>/.internal/svg-work/<主题>/gen.mjs`（用 write 工具，中文不进 heredoc）；
2. 填 CONFIG 配色（按风格设计主题色板）；
3. 按主题设计版式函数（卡片/时间轴/漏斗/对比栏等，用原子组件拼），生成全部页面并 push；
   替换掉示例页；文本用组件函数输出（自动转义、带安全字号默认值）；
4. `node gen.mjs` 一次产出 work/page-NN.svg。

文本用组件函数输出而非手写 `<text>`（自动转义、避免字号/颜色硬编码错误）；
设计一次成型，不要在页与页之间反复改风格。

### 第 2 步：建文件并编译全部页（一条 bash）

```bash
set -e
export UNIVER_HOME="<数据目录>/.internal/univer"
F="<项目根>/新PPT.univer"; SRC="<数据目录>/.internal/svg-work/<主题>"; TITLE="PPT标题"
node "$SRC/gen.mjs"
node "$UNIVER_CLI" new "$F" --name "$TITLE" --json
W=$(node "$UNIVER_CLI" worktree add "$F" --json | grep -oE '"worktreeId":"[^"]+"' | cut -d'"' -f4)
U=$(node "$UNIVER_CLI" unit add "$F" --type slide --name "$TITLE" --worktree "$W" --json | grep -oE '"unitId":"[^"]+"' | cut -d'"' -f4)
echo "W=$W U=$U"   # 记下给第 3 步用
for f in "$SRC"/work/page-*.svg; do
  p=$(basename "$f" .svg | sed 's/page-0*//')
  out=$(node "$UNIVER_CLI" compile-svg "$f" --page "$p" --apply "$F" --worktree "$W" --unit "$U" --json)
  echo "$out" | grep -q '"lints":\[\]' || { echo "compile lint 未清零：$f"; echo "$out"; exit 1; }
done
echo "编译全部 0 lint"
```

### 第 3 步：lint 门 + 推右侧（一条 bash，可重复跑）

> ⚠️ **铁律：永不自动合并。** 本技能只负责编辑 + lint 清零 + mark ready + 推右侧，**到达此步即停手**，
> 让用户自己在查看器里点「合并到主干」。`worktree merge` 是**用户手动动作**，Agent 不得代为执行。

```bash
set -e
node "$UNIVER_CLI" inspect presentation "$F" --unit "$U" --worktree "$W" --lint --json | tee "$SRC/lint.json"
node -e "const s=require('fs').readFileSync('$SRC/lint.json','utf8'); if(/\"lints\":\s*\[[^\]]/.test(s)) process.exit(1)"
node "$UNIVER_CLI" worktree ready "$F" --worktree "$W" --json   # 标记待确认，停下，等用户手动合并
# 推右侧：直写 open-request 标记文件，不依赖 HTTP 端口（打包版是随机端口）；UI 每 3 秒轮询消费。id 每次必须不同。
printf '{"id":"%s","filePath":"%s","title":"%s","updatedAt":"%s"}\n' "$(date +%s)-$$" "$F" "$TITLE" "$(date -u +%FT%TZ)" > "<数据目录>/.internal/pi-web-open-request.json"
```

- lint 报问题时：改 PAGES 数据表 → `node gen.mjs` → 只重编译问题页 → 重跑第 3 步，一轮收敛。
- **不要 univer status 预检**；修改已有 PPT 时每轮用新 worktree，只重编译受影响页。

### 质量门与反馈

- compile-svg 自带真 Chrome 文本度量（溢出/重叠报 warning 与 lint）——**lint 就是质量门**；
  **不要逐页 inspect，也不要逐页截图复核**（右侧实时预览用户自己看，截图省下 3-5 分钟）。
- 需要视觉存档时才跑一次 screenshot --contact-slide。

### 推送右侧与导出

- 推送两种方式：①第 3 步的 printf 直写 marker（推荐，无端口依赖，id 每次必须不同）；
  ②dev 端口 10141 时也可 write 写 UTF-8 JSON 后 `curl --data-binary @req.json`（中文禁止进 curl -d 内联参数，控制台 GBK 转码 → 404）。
- 编辑前与合并后都推一次（右侧未打开时打开；已打开时合并后查看器自动重载）。
- 导出交付：pi-studio 右侧已有「导出 PPT/文档」按钮（GET /api/univer/export?file=&unit=&format=pptx|docx），
  CLI 手动导出用 `node "$UNIVER_CLI" export <file> <out.pptx> --unit <slideUnitId>`（无 --out 选项）。

## 导入导出

```bash
univer import --file report.docx out.univer           # docx/pptx/xlsx/csv/tsv → 新文件基线
univer import --file deck.pptx out.univer --worktree W  # 作为已有文件的 worktree 提交
univer export f.univer f-out.pptx --unit <slideUnitId>   # 按单元 kind 导出 docx/pptx/xlsx/csv/tsv（无 --out 选项）
```

## UML / 示意图

Univer 无原生 UML 类型。两种实现路径（按需选择或组合）：

1. **Board 原生图**：类图/组件图/简单流程图用 Board 形状 + 连接器表达——先 `insertShapes()`
   建全部节点，再建 connector（元素绑定端点 + `routing:"orthogonal"`），移动节点连线跟随。
   适合：需要后续人工拖拽调整的架构图。
2. **SVG 嵌入**：生成标准 SVG（Mermaid 导出 SVG 或手绘 SVG）→ 幻灯片页用
   `univer compile-svg file.univer --svg u.svg --page N` 应用（文本可度量、可校验溢出）；
   文档/其他场景转 PNG 后走 `insertImage`。适合：布局复杂、不需再编辑的时序图/ER 图。

完成后把最终 PNG（screenshot 证据）随回复给出；.univer 主文件推送右侧查看器即可预览全部单元。
