// 临时测试：用 jsdom 验证 bridge.cjs 生成的 snapshot/execute 脚本逻辑。
// 运行：NODE_PATH=<jsdom安装目录>/node_modules node scripts/bridge-engine-test.cjs
// jsdom 不在项目依赖里，需单独装（示例）：
//   mkdir -p /tmp/jsdom-test && cd /tmp/jsdom-test && npm init -y && npm i jsdom
//   NODE_PATH=/tmp/jsdom-test/node_modules node scripts/bridge-engine-test.cjs
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { JSDOM } = require("jsdom");

const src = fs.readFileSync(path.join(__dirname, "..", "electron", "bridge.cjs"), "utf8");
const sandbox = { require, module: { exports: {} }, exports: {}, process, console, Buffer, setTimeout, clearTimeout, URL };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "bridge.cjs" });

const { pageEngine, snapshotScript, executeScript } = sandbox;

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  PASS:", msg);
  else { failures++; console.error("  FAIL:", msg); }
}

function prepareWindow(dom) {
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent || ""; },
    configurable: true,
  });
  const realGetRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    realGetRect.call(this);
    return { x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10 };
  };
  return window;
}

function runInDom(html, script) {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const window = prepareWindow(dom);
  const result = window.eval(script);
  window.close();
  return result;
}

async function runInDomAsync(html, script) {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const window = prepareWindow(dom);
  const result = await window.eval(script);
  window.close();
  return result;
}

// ---------- 1. snapshot 基础 ----------
console.log("\n[1] snapshot");
{
  const html = `
    <button id="q1">查询</button>
    <button id="q2">高级查询</button>
    <input id="sup" placeholder="供应商" value="全部">
    <input id="ord" placeholder="订单号">
    <select id="status"><option>全部</option><option>已审核</option></select>
    <a href="/x">查询结果</a>
    <button style="display:none">隐藏按钮</button>
  `;
  const snap = runInDom(html, snapshotScript(300));
  assert(snap.elements.length === 6, `收集 6 个可见交互元素，实际 ${snap.elements.length}`);
  const names = snap.elements.map((e) => e.name);
  assert(names.includes("查询"), "按钮「查询」name 正确");
  assert(names.includes("订单号"), "输入框 placeholder 作为 name");
  assert(snap.elements.find((e) => e.tag === "select").role === "combobox", "select role=combobox");
  assert(snap.elements.every((e) => !e.name || e.name.length <= 120), "name 截断");
  assert(snap.signature && snap.signature.length > 0, "signature 非空");
}

// ---------- 2. execute: fill + select(native) + click（一次 JS 上下文） ----------
console.log("\n[2] execute 批量动作（fill/select/click）");
(async () => {
  const html = `
    <input id="ord" placeholder="订单号">
    <select id="status"><option value="all">全部</option><option value="approved">已审核</option></select>
    <button id="q1">查询</button>
    <div id="result"></div>
  `;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const window = prepareWindow(dom);
  window.document.querySelector("#q1").addEventListener("click", () => {
    const ord = window.document.querySelector("#ord").value;
    const st = window.document.querySelector("#status").value;
    window.document.querySelector("#result").textContent = `queried:${ord}:${st}`;
  });
  const actions = [
    { type: "fill", ref: "e0", value: "PO001" },
    { type: "select", ref: "e1", value: "已审核" },
    { type: "click", ref: "e2" },
  ];
  const res = await window.eval(executeScript(actions, null, null));
  assert(res.ok === true, `execute 全部成功: ${JSON.stringify(res.results.map(r => ({ a: r.action, ok: r.ok, v: r.value || r.name })))}`);
  assert(window.document.querySelector("#result").textContent === "queried:PO001:approved", `点击后查询结果正确，实际 "${window.document.querySelector("#result").textContent}"`);
  window.close();
})();

// ---------- 3. 定位器评分：精确优先于 contains ----------
console.log("\n[3] 评分定位器（查询 vs 高级查询）");
{
  const html = `
    <button id="q1">查询</button>
    <button id="q2">高级查询</button>
    <button id="q3">查询结果</button>
  `;
  const res = runInDom(html, `(() => {
    const E = ${pageEngine(300)};
    const r = E.$findBest({ name: "查询", role: "button" });
    return { id: r.el ? r.el.id : null, score: r.score, gap: r.gap };
  })()`);
  assert(res.id === "q1", `「查询」命中精确按钮 q1，实际 ${res.id}（score=${res.score}, gap=${res.gap}）`);
  assert(res.gap >= 40, `gap 足够大（不歧义），实际 gap=${res.gap}`);
}

// ---------- 4. AMBIGUOUS：两个同分精确按钮 ----------
console.log("\n[4] 歧义检测");
{
  const html = `<button id="a">提交</button><button id="b">提交</button>`;
  const res = runInDom(html, `(() => {
    const E = ${pageEngine(300)};
    const r = E.$resolve({ target: { name: "提交", role: "button" } }, E.$collectLive(), null);
    return { err: r.err || null, candidates: r.candidates || [] };
  })()`);
  assert(res.err === "AMBIGUOUS", `两个「提交」→ AMBIGUOUS，实际 err=${res.err}`);
  assert(res.candidates && res.candidates.length === 2, `候选列表 2 条，实际 ${res.candidates && res.candidates.length}`);
}

// ---------- 5. ref 错位恢复（DOM 前插元素，ref 通过序号+名字校验仍命中） ----------
console.log("\n[5] ref 错位恢复");
(async () => {
  const html = `<input id="a" placeholder="A"><input id="b" placeholder="B">`;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const window = prepareWindow(dom);
  const snap = window.eval(snapshotScript(300));
  const meta = {
    signature: snap.signature,
    max: 300,
    refs: snap.elements.map((e, i) => ({ ref: e.ref, tag: e.tag, ord: i, name: e.name })),
  };
  // DOM 变化：最前面插入新 input#c → 原 e1(B) 现在下标变 2
  const inserted = window.document.createElement("input");
  inserted.id = "c"; inserted.placeholder = "C";
  window.document.body.prepend(inserted);
  const res = await window.eval(executeScript(
    [{ type: "fill", ref: "e1", value: "HELLO" }],
    "s_test", meta
  ));
  assert(res.snapshotInvalidated === true, `DOM 变化后 snapshotInvalidated=true，实际 ${res.snapshotInvalidated}`);
  assert(res.ok === false && /REF_STALE/.test(res.results[0].error), `错位 ref 安全失败为 REF_STALE（B 已移到 e2）: ${JSON.stringify(res.results)}`);
  assert(window.document.querySelector("#b").value === "", "B 未被误写");
  assert(window.document.querySelector("#c").value === "", "C 未被误写");
  assert(window.document.querySelector("#a").value === "", "A 未被误写");
  window.close();
})();

// ---------- 6. select: Ant Design 风格 combobox ----------
console.log("\n[6] Ant Design 风格 combobox select");
(async () => {
  const html = `
    <div class="ant-select">
      <div class="ant-select-selector">
        <input role="combobox" aria-haspopup="listbox" class="ant-select-selection-search-input">
        <span class="ant-select-selection-item">全部</span>
      </div>
    </div>
    <div class="ant-select-dropdown" style="display:none">
      <div class="ant-select-item-option" title="全部"><div>全部</div></div>
      <div class="ant-select-item-option" title="华为"><div>华为</div></div>
      <div class="ant-select-item-option" title="已审核"><div>已审核</div></div>
    </div>
  `;
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const window = prepareWindow(dom);
  const dropdown = window.document.querySelector(".ant-select-dropdown");
  const item = window.document.querySelector(".ant-select-selection-item");
  window.document.querySelector(".ant-select").addEventListener("click", () => {
    dropdown.style.display = "block";
  });
  // 模拟 antd：点击 option 后同步选中文案
  window.document.querySelectorAll(".ant-select-item-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      item.textContent = opt.getAttribute("title");
    });
  });
  const res = await window.eval(executeScript(
    [{ type: "select", ref: "e0", value: "华为" }],
    null, null
  ));
  assert(res.ok === true, `antd combobox select 成功: ${JSON.stringify(res.results)}`);
  assert(res.results[0].method === "dropdown", `走 dropdown 方法，实际 ${res.results[0].method}`);
  assert(item.textContent === "华为", `选中项为华为，实际 "${item.textContent}"`);
  window.close();
})();

// ---------- 7. wait 条件 ----------
console.log("\n[7] wait 条件");
(async () => {
  const html = `<div id="x">查询完成</div>`;
  const res = await runInDomAsync(html, `(async () => {
    const E = ${pageEngine(300)};
    return await E.$waitFor({ for: { text: "查询完成" }, timeout: 1000 });
  })()`);
  assert(res === true, "text 条件满足");
})();

// ---------- 8. open readyWhen 的 selector 检查脚本 ----------
console.log("\n[8] readyWhen selector 脚本");
{
  const html = `<div id="app"></div>`;
  const res = runInDom(html, `(() => { try { return { found: !!document.querySelector("#app") }; } catch (e) { return { found: false }; } })()`);
  assert(res.found === true, "#app 存在");
}

// ---------- 9. assert ----------
console.log("\n[9] assert");
{
  const html = `<input id="n" value="张三"><button disabled>禁用</button><div>页面已加载完成</div>`;
  const res = runInDom(html, `(() => {
    const E = ${pageEngine(300)};
    return {
      text: E.$assert({ text: "页面已加载完成" }),
      enabled: E.$assert({ target: { name: "张三" }, state: "enabled" }),
      value: E.$assert({ target: { name: "张三" }, state: "value", value: "张三" }),
    };
  })()`);
  assert(res.text.ok === true, "assertText 通过");
  assert(res.enabled.ok === true, "assert enabled 通过");
  assert(res.value.ok === true, "assert value 通过");
}

setTimeout(() => {
  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}, 1500);
