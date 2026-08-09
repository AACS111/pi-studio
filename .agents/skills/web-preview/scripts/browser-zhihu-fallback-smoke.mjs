// Verify: agent pushes an anti-bot URL (zhihu) → panel auto-switches to
// console mode (live mirror) instead of showing the 403 iframe error page.
import puppeteer from "puppeteer-core";
import http from "node:http";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP = "http://localhost:10141/";
const URL = "https://www.zhihu.com/question/2068854631464227633/answer/2069563885909185291";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function postJson(url, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on("error", rej); req.end(data);
  });
}
async function waitFor(fn, timeout, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch { }
    await sleep(400);
  }
  throw new Error("TIMEOUT: " + step);
}

(async () => {
  // Sidecar must be on the target page already (loaded in the previous step)
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new",
    args: ["--disable-extensions", "--disable-gpu", "--no-first-run", "--window-size=1600,1000"] });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 150)); });
    // 确定性进入可用状态（?session= 避免 marker 与你本机已打开的 pi-studio 会话抢）
    let sessionId = "";
    try {
      const sres = await request("http://localhost:10141/api/sessions");
      const slist = JSON.parse(sres.body);
      const sessions = Array.isArray(slist) ? slist : (slist.sessions || []);
      sessionId = sessions[0]?.id || "";
    } catch { /* 没有会话则走空状态 */ }
    await page.goto(`${APP}${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await waitFor(() => page.evaluate(() => !!document.querySelector("#file-panel")), 30000, "app shell");
    await new Promise((r) => setTimeout(r, 4000));

    // 打开空网页标签，然后在地址栏输入知乎 URL（与 marker 推送同一代码路径：
    // 代理预检 403 → 自动切到 Agent 控制台实时镜像）
    await waitFor(async () => page.evaluate(() => {
      const btn = document.querySelector(
        'button[aria-label="在面板中打开网页"], button[aria-label="Open a web page in the panel"]',
      );
      if (btn) { btn.click(); return true; }
      return null;
    }), 20000, "open-web-tab button");
    await new Promise((r) => setTimeout(r, 1500));
    // 受控输入：先设值 + 派发 input（React 异步提交状态），等一帧后再提交表单，
    // 否则同一任务里 handleSubmit 读到的是旧值（空串）
    await page.evaluate((url) => {
      const input = document.querySelector('input[type="text"]');
      input.focus(); // 真实用户点地址栏会聚焦；聚焦时 URL 轮询不会覆盖正在输入的内容
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, url);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, URL);
    await new Promise((r) => setTimeout(r, 120));
    await page.evaluate(() => {
      const input = document.querySelector('input[type="text"]');
      const form = input.closest("form");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await new Promise((r) => setTimeout(r, 1000));

    // Give the proxy pre-check time: it should auto-switch to console mode
    const switched = await waitFor(async () => page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")];
      const consoleBtn = btns.find((x) => (x.textContent || "").includes("Agent"));
      return consoleBtn && consoleBtn.getAttribute("aria-pressed") === "true" ? true : null;
    }), 25000, "auto-switch to console mode");
    console.log("auto-switched to console mode:", switched);

    // Live frame must render (real chrome mirror, not the 403 page)
    await waitFor(async () => page.evaluate(() => {
      const img = document.querySelector("img[src^='data:image/jpeg']");
      return img ? img.getAttribute("src").length : 0;
    }), 20000, "live frame rendered");
    const len = await page.evaluate(() => {
      const img = document.querySelector("img[src^='data:image/jpeg']");
      return img ? img.getAttribute("src").length : 0;
    });
    console.log("live frame bytes:", len);

    // Scroll inside the mirror → sidecar browser scrolls (title check would need content,
    // but the URL poll syncing proves consoleOnline; a wheel dispatch proves input path)
    await page.evaluate(() => {
      const img = document.querySelector("img[src^='data:image/jpeg']");
      img.dispatchEvent(new WheelEvent("wheel", { deltaY: 600, bubbles: true, cancelable: true }));
    });
    await sleep(1500);
    console.log("wheel dispatched to mirror (no crash)");

    console.log("AUTO_FALLBACK_OK");
  } finally { await browser.close(); }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
