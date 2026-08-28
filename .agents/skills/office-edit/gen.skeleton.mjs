// ============================================================
// gen.skeleton.mjs — PPT 生成骨架（office-edit skill 配套）
// 只含每个 PPT 都需要的基础设施：画布、字体、转义、原子组件、分页输出。
// 不含任何主题内容——配色、版式、页面函数、页数全部由本次主题决定。
// 用法：复制到工作目录（如 <数据目录>/.internal/svg-work/<主题>/gen.mjs），
//       ① 填 CONFIG 配色  ② 按主题写页面函数并 push 到 pages（页数不限）
//       ③ node gen.mjs → 产出 work/page-NN.svg（960×540）
// ============================================================
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "work");
mkdirSync(OUT, { recursive: true });

// ── 固定基础设施 ──────────────────────────────────────────
const W = 960, H = 540;
const FONT = `font-family="Microsoft YaHei, PingFang SC, sans-serif"`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── ① 配色：按本次主题填写（每个 PPT 自己的设计系统）────────
const C = {
  bg: "",       // 页面背景
  primary: "",  // 主色（标题条/重点）
  accent: "",   // 强调色（徽标/图形）
  ink: "",      // 正文
  dim: "",      // 次要文字
  card: "",     // 卡片底
  soft: "",     // 浅色块
};

// ── ② 原子组件（可按需扩展，不要内联堆 SVG）────────────────
const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n  <rect width="${W}" height="${H}" fill="${C.bg}"/>\n${inner}\n</svg>\n`;
const text = (x, y, s, { size = 24, fill = C.ink, weight = "", anchor = "" } = {}) =>
  `<text x="${x}" y="${y}"${anchor ? ` text-anchor="${anchor}"` : ""} ${FONT} font-size="${size}"${weight ? ` font-weight="${weight}"` : ""} fill="${fill}">${esc(s)}</text>`;
const rect = (x, y, w, h, { fill, rx = 0, stroke = "", sw = 2.5 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ""}/>`;
const pill = (cx, cy, s, { size = 26, fill = C.primary, color = "#FFFFFF" } = {}) => {
  const w = String(s).length * size + 80;
  return rect(cx - w / 2, cy - 29, w, 58, { fill, rx: 29 }) + "\n  " + text(cx, cy + 9, s, { size, fill: color, weight: "bold", anchor: "middle" });
};
const pageHead = (title) => // 内容页通用页首标题条
  rect(355, 44, 250, 58, { fill: C.primary, rx: 29 }) + "\n  " + text(480, 83, title, { size: 32, fill: "#FFFFFF", weight: "bold", anchor: "middle" });

// ── ③ 页面：按主题写版式函数与内容，push 到 pages（页数不限）──
// 下面的示例页仅演示 API 用法——按主题全部重写。
const pages = [];
pages.push(svg([
  pageHead("示例标题"),
  `  ` + text(480, 300, "按主题替换这一页", { size: 28, anchor: "middle", fill: C.dim }),
].join("\n")));

// ── 输出 ─────────────────────────────────────────────────
pages.forEach((p, i) => writeFileSync(join(OUT, `page-${String(i + 1).padStart(2, "0")}.svg`), p));
console.log(`generated ${pages.length} pages -> ${OUT}`);
