// 端到端测试：真实 HTTP bridge + jsdom 伪 WebContents，覆盖 /snapshot → /execute 全链路。
// 运行：NODE_PATH=<jsdom安装目录>/node_modules node scripts/bridge-http-test.cjs
// jsdom 不在项目依赖里，需单独装（示例）：
//   mkdir -p /tmp/jsdom-test && cd /tmp/jsdom-test && npm init -y && npm i jsdom
//   NODE_PATH=/tmp/jsdom-test/node_modules node scripts/bridge-http-test.cjs
const { JSDOM } = require("jsdom");
const { startBridge } = require("../electron/bridge.cjs");

function makeFakeWc(html) {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost:3000/order" });
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
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    getURL: () => "http://localhost:3000/order",
    getTitle: () => "采购订单",
    executeJavaScript: async (expr) => window.eval(expr),
    destroy: () => { destroyed = true; window.close(); },
  };
}

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  PASS:", msg);
  else { failures++; console.error("  FAIL:", msg); }
}

(async () => {
  const html = `
    <input id="ord" placeholder="订单号">
    <select id="status"><option value="all">全部</option><option value="approved">已审核</option></select>
    <button id="q1">查询</button>
    <div id="result"></div>
  `;
  const wc = makeFakeWc(html);
  const bridge = await startBridge({ getActiveView: () => wc, getDownloads: () => [], dataDir: null });
  const base = bridge.baseUrl;
  const post = async (p, body) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const get = async (p) => {
    const r = await fetch(base + p);
    return { status: r.status, body: await r.json() };
  };

  console.log("[1] GET /snapshot 返回 ref/role/name/value");
  const snap = (await get("/snapshot")).body;
  assert(snap.snapshotId && /^s_/.test(snap.snapshotId), `snapshotId 生成: ${snap.snapshotId}`);
  assert(snap.elements.length === 3, `3 个交互元素，实际 ${snap.elements.length}`);
  assert(snap.elements[0].ref === "e0" && snap.elements[0].name === "订单号", `e0 = 订单号输入框`);
  assert(snap.elements[1].role === "combobox" && snap.elements[1].value === "全部", `e1 = select（value=全部）`);

  console.log("[2] POST /execute 用 snapshotId + ref 批量执行");
  const ex = await post("/execute", {
    snapshotId: snap.snapshotId,
    actions: [
      { type: "fill", ref: "e0", value: "PO001" },
      { type: "select", ref: "e1", value: "已审核" },
      { type: "click", ref: "e2" },
    ],
  });
  assert(ex.status === 200 && ex.body.ok === true, `execute 200 ok`);
  assert(ex.body.completed === 3 && ex.body.failed === 0, `3 步全部完成`);
  assert(ex.body.results[0].action === "fill" && ex.body.results[0].ok, `fill 成功`);
  assert(ex.body.results[1].method === "native", `native select 成功`);
  assert(ex.body.results[2].action === "click" && ex.body.results[2].ok, `click 成功`);
  assert(ex.body.snapshotInvalidated === false, `DOM 未变，snapshotInvalidated=false`);

  console.log("[3] POST /click 语义定位（评分）");
  const ck = await post("/click", { target: { role: "button", name: "查询" } });
  assert(ck.status === 200 && ck.body.ok === true, `语义 click 成功: ${JSON.stringify(ck.body)}`);

  console.log("[4] POST /click 歧义 → 409 + candidates");
  wc.executeJavaScript(`(function(){
    const b = document.createElement('button'); b.id='q2'; b.textContent='查询';
    document.body.appendChild(b);
  })()`);
  const amb = await post("/click", { target: { role: "button", name: "查询" } });
  assert(amb.status === 409, `歧义返回 409，实际 ${amb.status}`);
  assert(Array.isArray(amb.body.candidates) && amb.body.candidates.length === 2, `candidates 2 条，实际 ${JSON.stringify(amb.body.candidates)}`);
  // 移除多余按钮
  await wc.executeJavaScript(`(function(){ const b = document.getElementById('q2'); if (b) b.remove(); })()`);

  console.log("[5] POST /click 找不到 → 404");
  const nf = await post("/click", { target: { name: "不存在的按钮XYZ" } });
  assert(nf.status === 404, `找不到返回 404，实际 ${nf.status}`);

  console.log("[6] POST /fill /select /check 单动作端点");
  const fl = await post("/fill", { selector: "#ord", value: "PO999" });
  assert(fl.status === 200 && fl.body.value === "PO999", `/fill 替换值成功`);
  const ty = await post("/type", { selector: "#ord", text: "-X", clear: false });
  assert(ty.status === 200 && ty.body.value === "PO999-X", `/type 追加成功: ${ty.body.value}`);
  const sel = await post("/select", { selector: "#status", value: "已审核" });
  assert(sel.status === 200 && sel.body.method === "native", `/select 原生成功`);
  const val = await wc.executeJavaScript(`document.getElementById('status').value`);
  assert(val === "approved", `select 实际选中 approved`);

  console.log("[7] POST /wait 与 /assert");
  const wait = await post("/wait", { for: { selector: "#ord" }, timeout: 500 });
  assert(wait.status === 200 && wait.body.satisfied === true, `/wait selector 满足`);
  const waitT = await post("/wait", { for: { text: "不存在的文案" }, timeout: 300 });
  assert(waitT.status === 200 && waitT.body.satisfied === false, `/wait 超时返回 satisfied=false`);
  const as = await post("/assert", { target: { name: "订单号" }, state: "visible" });
  assert(as.status === 200 && as.body.ok === true, `/assert visible 通过`);

  console.log("[8] POST /press 聚焦目标后按 Enter（无视图时 CDP 会失败 → 合成事件兜底）");
  const pr = await post("/press", { key: "Enter", target: { name: "订单号" } });
  // fake wc 没有 debugger，dispatchInput 会抛错 → 走合成事件 fallback
  assert(pr.status === 200 && pr.body.ok === true, `/press 返回 ok`);

  console.log("[9] POST /open 无 URL → 400");
  const op = await post("/open", {});
  assert(op.status === 400, `无效 URL 返回 400，实际 ${op.status}`);

  wc.destroy();
  bridge.server.close();
  console.log(failures === 0 ? "\nHTTP TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
