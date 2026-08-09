// scan-text-numbers.mjs — 扫描导出 xlsx 中的「文本形式数字」（Univer 绿色三角警告源）
// 用法: node scan-text-numbers.mjs <file.xlsx> [sheetName]
// 输出: 标准 A1 地址（如 R58E / AE12），避免列名歧义误判。
const XLSX = require("C:/Users/zheng/Desktop/pi-studio/pi-studio-main/node_modules/xlsx");

const file = process.argv[2];
if (!file) { console.error("usage: node scan-text-numbers.mjs <file.xlsx> [sheetName]"); process.exit(1); }
const only = process.argv[3];
const wb = XLSX.readFile(file);

// 0-based 列索引 → A1 列字母
function colL(n) {
  let s = ""; n = n + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

for (const name of wb.SheetNames) {
  if (only && name !== only) continue;
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  const found = [];
  rows.forEach((r, ri) => {
    r.forEach((v, ci) => {
      if (typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?%?$/.test(v.trim())) {
        found.push(`R${ri + 1}${colL(ci)}=${JSON.stringify(v)}`);
      }
    });
  });
  console.log(name, "=> 文本数字:", found.length, found.slice(0, 20).join(" "));
  if (found.length > 20) console.log("  ...共", found.length);
}
