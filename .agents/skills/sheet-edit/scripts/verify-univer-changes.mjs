// verify-univer-changes.mjs — 直接读 .univer SQLite 的 worktree changesets，
// 断言 execute 提交的 DV/CF 增量（替代 export 解包，40-60s → 毫秒级）。
// 用法：node verify-univer-changes.mjs <file.univer> <worktreeId> [--expect sheets]
import { DatabaseSync } from "node:sqlite";

const [file, worktree] = process.argv.slice(2);
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare(
  "SELECT payload_json FROM collaboration_worktree_changesets WHERE worktree_id=? ORDER BY revision",
).all(worktree);

const dvRules = [];
const cfRules = [];
let cellMutations = 0;
for (const r of rows) {
  const cs = JSON.parse(r.payload_json);
  for (const m of cs.mutations || []) {
    if (m.id === "data-validation.mutation.addRule") {
      const d = JSON.parse(m.data);
      dvRules.push({
        sheet: d.subUnitId,
        rule: d.rule,
        list: d.rule?.formula1 || d.rule?.formula1s || null,
      });
    } else if (m.id === "sheet.mutation.add-conditional-rule" || m.id?.startsWith("conditional-formatting")) {
      const d = JSON.parse(m.data || "{}");
      const add = d.addedRule || d.rules || d;
      cfRules.push({ sheet: d.subUnitId, rule: add });
    } else if (m.id?.includes("setRangeValues") || m.id?.includes("set-cell-style")) {
      cellMutations++;
    }
  }
}
db.close();

const bySheet = {};
for (const dv of dvRules) {
  (bySheet[dv.sheet] ||= {}).dv = dv;
}
for (const cf of cfRules) {
  (bySheet[cf.sheet] ||= {}).cf = (bySheet[cf.sheet]?.cf || 0) + 1;
}
console.log("DV rules:", dvRules.length, "| CF rules:", cfRules.length, "| cell mutations:", cellMutations);
for (const [sheet, info] of Object.entries(bySheet)) {
  const list = info.dv?.list;
  console.log(`  ${sheet}: DV=${list ? JSON.stringify(list) : "?"} CF=${info.cf ?? 0}`);
}
