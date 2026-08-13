// 专项测试：auto-wait（懒加载元素）+ 图标按钮 title 匹配 + evaluate 参数传递。
// 运行：NODE_PATH=/tmp/jsdom-test/node_modules node scripts/bridge-autowait-test.cjs
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

async function runInDomAsync(html, script) {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const window = prepareWindow(dom);
  const result = await window.eval(script);
  window.close();
  return result;
}

(async () => {
  console.log("[1] auto-wait：元素稍后出现也能等到（模拟懒加载 500ms 后插入按钮）");
  {
    const html = `<body><div id="slot"></div><div id="result"></div></body>`;
    const script = `
      (async () => {
        const E = ${pageEngine(100)};
        setTimeout(() => {
          const b = document.createElement('button');
          b.id = 'late-btn';
          b.textContent = '晚到按钮';
          document.getElementById('slot').appendChild(b);
        }, 500);
        await E.$sleep(50);
        const target = { name: '晚到按钮' };
        const r = E.$findBest(target);
        if (r.el) return { found: true, waited: false };
        const ready = await E.$waitActionable(await (async () => {
          // 元素还没出现，先轮询 findBest 直到出现
          let el = null;
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline && !el) {
            el = E.$findBest(target).el || null;
            if (!el) await E.$sleep(100);
          }
          return el;
        })(), 1000);
        return { found: !!r.el, lateFound: ready, target: E.$elName(document.getElementById('late-btn')) };
      })()
    `;
    const res = await runInDomAsync(html, script);
    assert(res.lateFound === true, `晚到元素被 auto-wait 等到（target=${res.target}）`);
  }

  console.log("[2] auto-wait：disabled 元素等待后仍报 NOT_ACTIONABLE（不会误点）");
  {
    const html = `<body><button id="d" disabled>提交</button></body>`;
    const script = `
      (async () => {
        const E = ${pageEngine(100)};
        const el = document.getElementById('d');
        const ready = await E.$waitActionable(el, 300);
        return { ready, disabled: el.disabled };
      })()
    `;
    const res = await runInDomAsync(html, script);
    assert(res.ready === false, `disabled 元素 NOT_ACTIONABLE（ready=${res.ready}）`);
  }

  console.log("[3] 图标按钮：无文本但带 title → 快照 name 用 title，语义点击命中");
  {
    const html = `<body>
      <button id="icon1" title="刷新"><svg><title>刷新图标</title></svg></button>
      <button id="icon2" title="导出"><svg><title>导出图标</title></svg></button>
    </body>`;
    const script = `
      (async () => {
        const E = ${pageEngine(100)};
        const els = E.$collect();
        const names = els.map(e => e.name);
        const r1 = E.$findBest({ name: '刷新' });
        const r2 = E.$findBest({ name: '导出' });
        return {
          names,
          refreshHit: r1.el ? r1.el.id : null,
          exportHit: r2.el ? r2.el.id : null,
        };
      })()
    `;
    const res = await runInDomAsync(html, script);
    assert(res.names.includes("刷新") && res.names.includes("导出"), `快照 name 含 title（${JSON.stringify(res.names)}）`);
    assert(res.refreshHit === "icon1", `「刷新」命中 icon1，实际 ${res.refreshHit}`);
    assert(res.exportHit === "icon2", `「导出」命中 icon2，实际 ${res.exportHit}`);
  }

  console.log("[4] evaluate 包装：普通表达式 / 函数式 + args / 抛错透传");
  {
    // 验证 wrapExpr 的生成逻辑（直接复用端点里的正则）
    const makeWrap = (expr, args) => {
      const src = String(expr);
      const argsJson = JSON.stringify(args);
      if (/^\s*(\([^)]*\)|function\b[^({]*)\s*=>/.test(src) || /^\s*function\b/.test(src)) {
        return `(async () => { const fn = (${src}); return await fn.apply(null, ${argsJson}); })()`;
      }
      return `(async () => { const out = (${src}); return (typeof out === 'function') ? await out.apply(null, ${argsJson}) : out; })()`;
    };
    // 函数式 + args
    const fnExpr = "(a, b) => ({ sum: a + b, label: '结果' })";
    const wrap1 = makeWrap(fnExpr, [2, 3]);
    const r1 = await runInDomAsync("<body></body>", `(${wrap1})`);
    assert(r1.sum === 5 && r1.label === "结果", `函数式+args 求值正确（${JSON.stringify(r1)}）`);
    // 普通表达式
    const wrap2 = makeWrap("document.title", []);
    const r2 = await runInDomAsync("<body></body>", `(${wrap2})`);
    assert(typeof r2 === "string", `普通表达式求值正确（${typeof r2}）`);
    // 抛错：await 会 reject → 端点里被 catch 返回 {ok:false}
    const wrap3 = makeWrap("(() => { throw new Error('boom'); })()", []);
    let threw = false;
    try { await runInDomAsync("<body></body>", `(${wrap3})`); } catch (e) { threw = true; }
    assert(threw === true, "JS 抛错会 reject（端点 catch 后返回 ok:false）");
  }

  console.log("[5] execute 全链路：图标按钮点击走 auto-wait + title 定位");
  {
    const html = `<body><button id="go" title="开始"><svg><title>开始图标</title></svg></button><div id="out"></div></body>`;
    const actions = [{ type: 'click', target: { name: '开始' } }];
    const exec = executeScript(actions, "s_test", { signature: "x", refs: [] }, 100);
    const script = `
      (async () => {
        const E = ${pageEngine(100)};
        const els = E.$collectLive();
        const refsMap = els.map((e, i) => ({ ref: 'e' + i, tag: e.tag, ord: i, name: e.name }));
        const res = await (${exec});
        return { res };
      })()
    `;
    const res = await runInDomAsync(html, script);
    assert(res.res.ok === true, `execute 图标按钮点击成功（${JSON.stringify(res.res.results)}）`);
  }

  console.log(failures === 0 ? "\nALL AUTOWAIT TESTS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST ERROR:", e); process.exit(1); });
