// vendor-dropdown-cf.mjs — 自包含生成器：给指定列加下拉数据验证 + 按值配色（条件格式）
//
// 用法（execute 环境注入 workbook + univerAPI，本脚本为 ESM）：
//   univer execute <file> --worktree <wt> --unit <unitId> --script <本文件绝对路径> --json
//
// 设计（2026-08-07 在「原材料交期表 (15)」实测验证）：
// - 下拉列表 = 每 sheet 该列去重值，按出现频率降序（贴近使用习惯）；
// - 配色 = 全部值按全局频率排序，等距色相 + 明度交错（相邻值 RGB 距离 96-131，
//   避免旧黄金角方案相邻值几乎同色的问题）；同一值在任何 sheet 都是同一色；
// - Excel 注意：内联 LIST 验证拼串 >255 字符（如 42 家厂商）在 pi-studio 查看器
//   完全正常，但 xlsx 写回后 Excel 可能截断显示（其余小表无此问题）。范围引用
//   方案更糟：当前 Univer 导出为 [unitId]表!A1:A3 的 Excel 无法解析格式，勿用。
//
// 参数（按需修改顶部常量）：
//   TARGET_COL    目标列（0 基，B=1）
//   HEADER_TEXT   该列表头（仅用于确认，不校验强约束）
//   DATA_START_ROW 数据起始行（0 基，表头占 0-1 行时取 2）

const TARGET_COL = 1;            // B 列 = 厂商
const HEADER_TEXT = "厂商";
const DATA_START_ROW = 2;        // 双行表头（r0/r1），数据从 r2 开始
const MAX_SCAN_ROWS = 20000;

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return "#" + to(f(0)) + to(f(8)) + to(f(4));
}

const sheets = workbook.getSheets();
const perSheet = new Map(); // sheetName -> { list: [{v,n}], lastRow }
const global = new Map();   // value -> total count

for (const sheet of sheets) {
  const name = sheet.getSheetName();
  const maxRow = sheet.getLastRow();
  const vendors = new Map();
  let lastRow = DATA_START_ROW - 1;
  for (let r = DATA_START_ROW; r <= maxRow && r < MAX_SCAN_ROWS; r++) {
    const cell = sheet.getRange(r, TARGET_COL, 1, 1).getCellData();
    const v = cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== "" ? String(cell.v) : null;
    if (v) {
      vendors.set(v, (vendors.get(v) || 0) + 1);
      lastRow = r;
    }
  }
  if (vendors.size === 0) continue;
  perSheet.set(name, {
    list: [...vendors.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v),
    lastRow,
  });
  for (const [v, n] of vendors) global.set(v, (global.get(v) || 0) + n);
}

const globalOrder = [...global.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
const colorMap = {};
globalOrder.forEach((v, i) => {
  colorMap[v] = hslToHex((i * 360) / globalOrder.length, 65, i % 2 ? 62 : 84);
});

const out = [];
for (const [name, info] of perSheet) {
  const sheet = workbook.getSheetByName(name);

  // 1) 下拉数据验证（覆盖本列数据区）
  const dv = univerAPI
    .newDataValidation()
    .requireValueInList(info.list)
    .setAllowBlank(true)
    .setAllowInvalid(true)
    .setOptions({ showDropDown: true, showErrorMessage: true })
    .build();
  sheet.getRange(DATA_START_ROW, TARGET_COL, info.lastRow - DATA_START_ROW + 1, 1).setDataValidation(dv);

  // 2) 条件格式：只替换本列的旧规则（不影响其他列既有 CF）
  for (const r of sheet.getConditionalFormattingRules()) {
    const hits = (r.ranges || []).some(
      (rg) => rg.startColumn <= TARGET_COL && rg.endColumn >= TARGET_COL,
    );
    if (hits) {
      try { sheet.deleteConditionalFormattingRule(r.cfId); } catch { /* ignore */ }
    }
  }
  let cf = 0;
  for (const v of info.list) {
    const rule = sheet
      .newConditionalFormattingRule()
      .whenTextEqualTo(v)
      .setBackground(colorMap[v])
      .setRanges([{ startRow: DATA_START_ROW, endRow: info.lastRow, startColumn: TARGET_COL, endColumn: TARGET_COL }])
      .build();
    sheet.addConditionalFormattingRule(rule);
    cf++;
  }

  const listChars = info.list.join(",").length;
  out.push({
    sheet: name,
    vendors: info.list.length,
    cf,
    dvRange: "B" + (DATA_START_ROW + 1) + ":B" + (info.lastRow + 1),
    listChars,
    excelListOver255: listChars > 255,
  });
}

return {
  column: TARGET_COL,
  header: HEADER_TEXT,
  totalVendors: globalOrder.length,
  sheets: out,
};
