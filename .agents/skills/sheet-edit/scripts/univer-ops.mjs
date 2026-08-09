// univer-ops.mjs — 通用表格操作脚本库（参数化，覆盖常用操作）
//
// 设计（用户 2026-08-08 洞察：上传的表格都不同、内容也不同，只有操作是相同的）：
// 把「读/写/清空/格式/合并/行列/下拉/条件格式/尺寸」沉淀为参数化操作，
// agent 对任意 .univer 文件只需构造 JSON 配置 + 一次 execute，不用每次写定制脚本。
//
// 用法：
//   UNIVER_OPS_FILE=/path/ops.json univer execute <file> --worktree <wt> --unit <id> \
//     --script <本文件绝对路径> --json
//
// ops.json 结构（顶层数组，按序执行；单操作也可直接传对象）：
// [
//   { "op": "read",     "sheet": "Sheet1", "range": "A1:C5",            "withStyle": false },
//   { "op": "write",    "sheet": "Sheet1", "range": "B2",  "value": "文本", "t": 1 },
//   { "op": "write",    "sheet": "Sheet1", "range": "B3:C4", "grid": [["a",1],[2,"b"]] },
//   { "op": "formula",  "sheet": "Sheet1", "range": "D5",  "formula": "=SUM(B3:C4)" },
//   { "op": "clear",    "sheet": "Sheet1", "range": "B2:C4", "format": false },   // format:true 连格式一起清
//   { "op": "style",    "sheet": "Sheet1", "range": "A1",  "style": { "bg": "#FFF2CC", "bold": true, "color": "#CC0000", "align": "center", "format": "yyyy-MM-DD" } },
//   { "op": "merge",    "sheet": "Sheet1", "range": "A1:C1", "merge": true },
//   { "op": "rows",     "sheet": "Sheet1", "row": 5, "count": 2, "insert": true },   // insert:false = 删除
//   { "op": "dropdown", "sheet": "Sheet1", "range": "A3:A100", "list": ["BJ","SZ","HK"] },  // 内联 LIST 下拉
//   { "op": "dateValidation", "sheet": "Sheet1", "range": "N2:N423" },   // 日期验证(between 1900-01-01~9999-12-31，允许空白/无效值)
//   { "op": "dropdownFromColumn", "sheet": "Sheet1", "range": "B2:B200", "sourceRange": "B2:B200" }, // 按本列去重
//   { "op": "cf",       "sheet": "Sheet1", "range": "C3:C8", "type": "numberGreaterThan", "value": 100000, "bg": "#FF0000", "color": "#CC0000" },
//   { "op": "cfText",   "sheet": "Sheet1", "range": "A3:A100", "map": { "BJ": "#FFC000", "SZ": "#92D050" } },
//   { "op": "colWidth",  "sheet": "Sheet1", "col": 31, "width": 400 },            // col 1-based，width 像素
//   { "op": "normalize", "sheet": "Sheet1", "range": "Y2:Y423" },                // 字符串数字→数字（CF 数值比较前必做）
//   { "op": "dims",     "sheet": "Sheet1", "rows": 150, "cols": 26 }
// ]
//
// 约定（与 univer-cli sheet skill 一致）：
// - range 为 A1 风格（1 起始，含两端）；sheet 缺省用活动 sheet；
// - 写值必须带 t（1 文本/2 数字/3 布尔/4 强制文本）；grid 二维数组按行填写；
// - 颜色一律 xlsx 安全色 "#RRGGBB"；日期是数字 + 数字格式；
// - 返回每个 op 的结果（read 返回单元格数据；其余返回影响范围）。

// 用法（agent 生成临时脚本，把 ops JSON 内联到 __OPS__ 占位符）：
//   const tmpl = fs.readFileSync('.../univer-ops.mjs', 'utf8');
//   fs.writeFileSync('/tmp/ops-run.mjs', tmpl.replace('__OPS__', JSON.stringify(ops)));
//   univer execute <file> --worktree <wt> --unit <id> --script /tmp/ops-run.mjs --json
// 说明：不用环境变量/外部文件传参（Windows .cmd shim 会丢 env，execute 也
// 不支持顶层 import——统一用模板内联，一次 execute 跑完全部 ops）。

const ops = __OPS__;
const list = Array.isArray(ops) ? ops : [ops];

function sheetOf(name) {
  if (!name) return workbook.getActiveSheet();
  const s = workbook.getSheetByName(name);
  if (!s) throw new Error(`sheet not found: ${name}`);
  return s;
}

function rangeOf(sheet, rng) {
  return typeof rng === "string" ? sheet.getRange(rng) : sheet.getRange(rng.row - 1, rng.col - 1, rng.rows, rng.cols);
}

// Parse an A1-style range (e.g. "C3:C8" / "A3" ) into zero-based row/col bounds.
function parseA1(rng) {
  const [a, b] = rng.split(":");
  const one = (s) => {
    const m = s.match(/^([A-Z]+)(\d+)$/);
    if (!m) throw new Error(`bad range: ${rng}`);
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { row: Number(m[2]) - 1, col: col - 1 };
  };
  const p1 = one(a);
  const p2 = b ? one(b) : p1;
  return {
    startRow: Math.min(p1.row, p2.row),
    endRow: Math.max(p1.row, p2.row),
    startColumn: Math.min(p1.col, p2.col),
    endColumn: Math.max(p1.col, p2.col),
  };
}

// "A" → 1, "AB" → 28（1-based 列号）
function letterCol(letters) {
  let c = 0;
  for (const ch of letters.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c;
}

const results = [];
for (const op of list) {
  const sheet = sheetOf(op.sheet);
  switch (op.op) {
    case "read": {
      const r = rangeOf(sheet, op.range);
      const data = r.getCellDatas ? r.getCellDatas() : r.getCellData();
      results.push({ op: "read", range: op.range, data });
      break;
    }
    case "write": {
      // grid 配单格 range（如 A1）时自动扩展到 grid 尺寸——setValues 要求
      // 目标范围与矩阵匹配，否则只写左上角。
      const r = (() => {
        if (op.grid && !op.range.includes(":")) {
          const m = op.range.match(/^([A-Z]+)(\d+)$/);
          if (m) {
            const rows = op.grid.length;
            const cols = Math.max(...op.grid.map((x) => x.length));
            const colEnd = (n) => {
              let s = "";
              n = n - 1;
              do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
              return s;
            };
            return sheet.getRange(`${m[1]}${m[2]}:${colEnd(letterCol(m[1]) + cols)}${Number(m[2]) + rows - 1}`);
          }
        }
        return rangeOf(sheet, op.range);
      })();
      if (op.grid) {
        r.setValues(op.grid.map((row) => row.map((v) => (v && typeof v === "object" ? v : { v, t: typeof v === "number" ? 2 : 1 }))));
      } else {
        r.setValue({ v: op.value, t: op.t ?? (typeof op.value === "number" ? 2 : 1) });
      }
      results.push({ op: "write", range: op.range, ok: true });
      break;
    }
    case "formula": {
      const r = rangeOf(sheet, op.range);
      r.setFormula(op.formula);
      results.push({ op: "formula", range: op.range, ok: true });
      break;
    }
    case "clear": {
      const r = rangeOf(sheet, op.range);
      if (op.format) r.clear(); else r.clearContent();
      results.push({ op: "clear", range: op.range, format: !!op.format, ok: true });
      break;
    }
    case "style": {
      const r = rangeOf(sheet, op.range);
      const st = {};
      if (op.style.bg) st.bg = { rgb: op.style.bg };
      if (op.style.color) st.cl = { rgb: op.style.color };
      if (op.style.bold) st.bl = 1;
      if (op.style.align === "center") st.ht = 2;
      else if (op.style.align === "right") st.ht = 3;
      if (op.style.format) st.n = { pattern: op.style.format };
      r.setValue({ s: st });
      results.push({ op: "style", range: op.range, ok: true });
      break;
    }
    case "merge": {
      const r = rangeOf(sheet, op.range);
      if (op.merge) {
        r.merge();
      } else {
        // FRange has no unmerge() in this CLI build — use the underlying
        // command (same call the viewer uses for scope diff-apply).
        await univerAPI.executeCommand("sheet.command.remove-worksheet-merge", {
          unitId: workbook.getId(),
          subUnitId: sheet.getSheetId(),
          ranges: [parseA1(op.range)],
        });
      }
      results.push({ op: "merge", range: op.range, merge: op.merge, ok: true });
      break;
    }
    case "rows": {
      if (op.insert) sheet.insertRows(op.row - 1, op.count ?? 1);
      else sheet.deleteRows(op.row - 1, op.count ?? 1);
      results.push({ op: "rows", row: op.row, count: op.count ?? 1, insert: op.insert, ok: true });
      break;
    }
    case "dropdown": {
      const dv = univerAPI
        .newDataValidation()
        .requireValueInList(op.list)
        .setAllowBlank(op.allowBlank !== false)
        .setAllowInvalid(op.allowInvalid !== false)
        .setOptions({ showDropDown: true, showErrorMessage: true })
        .build();
      rangeOf(sheet, op.range).setDataValidation(dv);
      results.push({ op: "dropdown", range: op.range, list: op.list, ok: true });
      break;
    }
    case "dateValidation": {
      const dv = univerAPI
        .newDataValidation()
        .requireDateBetween(new Date(op.start || "1900-01-01"), new Date(op.end || "9999-12-31"))
        .setAllowBlank(op.allowBlank !== false)
        .setAllowInvalid(op.allowInvalid !== false)
        .setOptions({ showErrorMessage: true })
        .build();
      rangeOf(sheet, op.range).setDataValidation(dv);
      results.push({ op: "dateValidation", range: op.range, ok: true });
      break;
    }
    case "dropdownFromColumn": {
      const pr = parseA1(op.sourceRange);
      const vals = new Set();
      // getCellData() (singular) only returns the FIRST cell on a multi-range,
      // so read cell-by-cell instead of trusting the array shape.
      for (let r = pr.startRow; r <= pr.endRow; r++) {
        for (let c = pr.startColumn; c <= pr.endColumn; c++) {
          const cell = sheet.getRange(r, c, 1, 1).getCellData();
          const v = cell && cell.v;
          if (v !== undefined && v !== null && String(v).trim() !== "") vals.add(String(v).trim());
        }
      }
      const list = [...vals];
      const dv = univerAPI
        .newDataValidation()
        .requireValueInList(list)
        .setAllowBlank(true)
        .setAllowInvalid(true)
        .setOptions({ showDropDown: true, showErrorMessage: true })
        .build();
      rangeOf(sheet, op.range).setDataValidation(dv);
      results.push({ op: "dropdownFromColumn", range: op.range, list, ok: true });
      break;
    }
    case "cf": {
      let rule;
      if (op.type === "numberGreaterThan") rule = sheet.newConditionalFormattingRule().whenNumberGreaterThan(op.value);
      else if (op.type === "numberLessThan") rule = sheet.newConditionalFormattingRule().whenNumberLessThan(op.value);
      else if (op.type === "numberBetween") rule = sheet.newConditionalFormattingRule().whenNumberBetween(op.value[0], op.value[1]);
      else throw new Error(`unsupported cf type: ${op.type}`);
      if (op.bg) rule.setBackground(op.bg);
      if (op.color) rule.setFontColor(op.color);
      const rng = parseA1(op.range);
      rule.setRanges([rng]);
      sheet.addConditionalFormattingRule(rule.build());
      results.push({ op: "cf", range: op.range, type: op.type, bg: op.bg, color: op.color, ok: true });
      break;
    }
    case "cfText": {
      const rng = parseA1(op.range);
      let n = 0;
      for (const [text, bg] of Object.entries(op.map)) {
        sheet.newConditionalFormattingRule()
          .whenTextEqualTo(text)
          .setBackground(bg)
          .setRanges([rng])
          .build();
        n++;
      }
      results.push({ op: "cfText", range: op.range, rules: n, ok: true });
      break;
    }
    case "createSheet": {
      workbook.insertSheet(op.name, op.options);
      results.push({ op: "createSheet", name: op.name, ok: true });
      break;
    }
    case "deleteSheet": {
      const s = workbook.getSheetByName(op.name);
      if (s) workbook.deleteSheet(s.getSheetId());
      results.push({ op: "deleteSheet", name: op.name, ok: !!s });
      break;
    }
    case "colWidth": {
      sheet.setColumnWidth(op.col - 1, op.width);
      results.push({ op: "colWidth", col: op.col, width: op.width, ok: true });
      break;
    }
    case "fixTextNumbers": {
      // 消除「以文本形式存储的数字」绿色三角警告：%结尾文本→数字+百分比格式；
      // 纯数字文本→数字。
      const pr = parseA1(op.range);
      let n = 0, pct = 0;
      for (let r = pr.startRow; r <= pr.endRow; r++) {
        for (let c = pr.startColumn; c <= pr.endColumn; c++) {
          const cell = sheet.getRange(r, c, 1, 1).getCellData();
          const v = cell && cell.v;
          if (typeof v !== "string") continue;
          const s = v.trim();
          if (s === "" || !/^-?\d+(\.\d+)?%?$/.test(s)) continue;
          const isPct = s.endsWith("%");
          const num = Number(s.replace(/%$/, "")) / (isPct ? 100 : 1);
          sheet.getRange(r, c, 1, 1).setValue(
            isPct
              ? { v: num, t: 2, s: { n: { pattern: op.percentPattern || "0.0%" } } }
              : { v: num, t: 2 }
          );
          if (isPct) pct++; else n++;
        }
      }
      results.push({ op: "fixTextNumbers", range: op.range, numbers: n, percents: pct, ok: true });
      break;
    }
    case "normalize": {
      // 字符串数字→数字（保持值不变，仅改类型）。CF 数值比较/排序前必做。
      const pr = parseA1(op.range);
      let n = 0;
      for (let r = pr.startRow; r <= pr.endRow; r++) {
        for (let c = pr.startColumn; c <= pr.endColumn; c++) {
          const cell = sheet.getRange(r, c, 1, 1).getCellData();
          const v = cell && cell.v;
          if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) {
            sheet.getRange(r, c, 1, 1).setValue({ v: Number(v), t: 2 });
            n++;
          }
        }
      }
      results.push({ op: "normalize", range: op.range, converted: n, ok: true });
      break;
    }
    case "dims": {
      if (op.rows) sheet.setRowCount(op.rows);
      if (op.cols) sheet.setColumnCount(op.cols);
      results.push({ op: "dims", rows: op.rows, cols: op.cols, ok: true });
      break;
    }
    default:
      throw new Error(`unknown op: ${op.op}`);
  }
}

return { ops: results.length, results };
