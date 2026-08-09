// Headless smoke test: live interactive console mirror (Codex/WebBuddy-style).
// Verifies:
//  1. Switching the web tab to "Agent 控制台" mode renders live JPEG frames (SSE).
//  2. Clicking the mirror image forwards a CDP input click to the sidecar.
//  3. The address bar in console mode drives the real browser (via /open).
// Run against a live dev server on 10141 + browser-use sidecar on 17865.
import puppeteer from "puppeteer-core";
import http from "node:http";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP = "http://localhost:10141/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(url, opts = {}) {
  return new Promise((res, rej) => {
    const req = http.request(url, opts, (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res({ status: r.statusCode, body: d }); } catch (e) { rej(e); } });
    });
    req.on("error", rej);
    if (opts.body) req.end(opts.body); else req.end();
  });
}
const postJson = (url, body) => request(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function waitFor(fn, timeout, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(400);
  }
  throw new Error(`TIMEOUT: ${step}`);
}

(async () => {
  // Make sure the sidecar is healthy
  const health = await request("http://127.0.0.1:17865/health");
  const h = JSON.parse(health.body);
  console.log("sidecar health:", health.status, h.browser);

  // Put the sidecar on a page with a button that records clicks
  await postJson("http://127.0.0.1:17865/open", {
    url: "data:text/html,<button id=b onclick=document.title='CLICKED!'>hit me</button><style>body{margin:0}button{width:400px;height:200px;font-size:40px}</style>",
  });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--disable-extensions", "--disable-gpu", "--no-first-run", "--window-size=1600,1000"],
  });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200)); });
    // 确定性进入可用状态：先取一个真实会话 id，带 ?session= 进应用（占位态下
    // 右侧面板不渲染「打开网页」按钮；marker 又会和你本机已打开的 pi-studio 会话抢）
    let sessionId = "";
    try {
      const sres = await request("http://localhost:10141/api/sessions");
      const slist = JSON.parse(sres.body);
      const sessions = Array.isArray(slist) ? slist : (slist.sessions || []);
      sessionId = sessions[0]?.id || "";
    } catch { /* 没有会话则走空状态 */ }
    console.log("[step] session:", sessionId.slice(0, 12));
    await page.goto(`${APP}${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await waitFor(() => page.evaluate(() => !!document.querySelector("#file-panel")), 30000, "app shell mounted");
    console.log("[step] shell ok");
    // 等会话完全加载（当前会话可能在流式输出，避免点击落在初始渲染间隙）
    await sleep(4000);
    console.log("[step] settled");

    // 打开一个空网页标签（点面板的「打开网页」按钮；若点了没反应则重试一次）
    const clickOpenWeb = async () => page.evaluate(() => {
      const btn = document.querySelector(
        'button[aria-label="在面板中打开网页"], button[aria-label="Open a web page in the panel"]',
      );
      if (btn) { btn.click(); return true; }
      return false;
    });
    await waitFor(clickOpenWeb, 20000, "open-web-tab button");
    console.log("[step] open-web clicked");
    await sleep(1500);
    // 确认「Agent 控制台」按钮出现
    const hasAgentBtn = async () => page.evaluate(() =>
      [...document.querySelectorAll("button")].some((x) => (x.textContent || "").includes("Agent")),
    );
    if (!(await hasAgentBtn())) {
      await clickOpenWeb(); // 首次点击可能落在会话初始渲染间隙，重试一次
      await sleep(1500);
    }
    await waitFor(hasAgentBtn, 30000, "console mode button");
    console.log("[step] console mode button ok");

    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const b = btns.find((x) => (x.textContent || "").includes("Agent"));
      b.click();
    });

    // Live JPEG frame must appear (SSE stream → data:image/jpeg)
    await waitFor(async () => page.evaluate(() => {
      const img = document.querySelector("img[src^='data:image/jpeg']");
      return img ? img.getAttribute("src").length : 0;
    }), 20000, "live jpeg frame rendered");
    const frameLen = await page.evaluate(() => {
      const img = document.querySelector("img[src^='data:image/jpeg']");
      return img ? img.getAttribute("src").length : 0;
    });
    console.log("live frame length:", frameLen, "(>20000 means SSE streaming works)");

    // Click the mirror at ~40%,40% of the displayed image → button at top-left
    await page.evaluate(() => {
      const img = document.querySelector("img[src^='data:image/jpeg']");
      const r = img.getBoundingClientRect();
      img.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, clientX: r.left + r.width * 0.2, clientY: r.top + r.height * 0.12,
      }));
    });
    await sleep(800);

    // The button's onclick set document.title — verify via sidecar evaluate
    const title = await postJson("http://127.0.0.1:17865/evaluate", {
      expression: "document.title",
    });
    console.log("title after mirror click:", title.body.slice(0, 120));
    if (!title.body.includes("CLICKED!")) throw new Error("mirror click did not reach the sidecar browser");

    // Console address-bar navigation → /open drives the real browser
    // （受控输入：先设值派发 input，等 React 提交状态后再提交表单）
    await page.evaluate(() => {
      const input = document.querySelector('input[type="text"]');
      input.focus(); // 真实用户点地址栏会聚焦；聚焦时 URL 轮询不会覆盖正在输入的内容
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "https://example.com/");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(300);
    const barVal = await page.evaluate(() => document.querySelector('input[type="text"]').value);
    console.log("[step] address bar value:", barVal.slice(0, 40));
    await page.evaluate(() => {
      const input = document.querySelector('input[type="text"]');
      const form = input.closest("form");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const url = await waitFor(async () => {
      const r = await request("http://127.0.0.1:17865/url");
      const j = JSON.parse(r.body);
      return j.url && j.url.includes("example.com") ? j.url : null;
    }, 20000, "address bar navigated the real browser");
    console.log("address-bar navigated sidecar to:", url);

    console.log("CONSOLE_SMOKE_OK");
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
