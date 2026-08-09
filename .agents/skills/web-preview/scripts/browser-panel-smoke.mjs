// Headless smoke test: right-panel web browser (Codex-style preview).
// Verifies:
//  1. POST /api/browser (agent marker) auto-opens a web tab in the panel.
//  2. The tab renders the proxied page (example.com) in the sandboxed iframe.
//  3. Address-bar navigation works (navigate to example.org) — proving the
//     panel survives and stays interactive after the initial load.
// Run against a live dev server on 10141.
import puppeteer from "puppeteer-core";
import http from "node:http";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP = "http://localhost:10141/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function postJson(url, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on("error", rej);
    req.end(data);
  });
}

async function waitFor(fn, timeout, step) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    await sleep(500);
  }
  throw new Error(`TIMEOUT: ${step}${lastErr ? " (" + String(lastErr).slice(0, 200) + ")" : ""}`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--disable-extensions", "--disable-gpu", "--no-first-run", "--window-size=1600,1000"],
  });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200)); });
    await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitFor(() => page.evaluate(() => !!document.querySelector("body")), 15000, "body");
    // Wait for the app shell to be mounted (React hydration finished) before
    // posting the marker — posting earlier races the first-request compile.
    await waitFor(() => page.evaluate(() => !!document.querySelector("#file-panel")), 30000, "app shell mounted");

    // 1. Agent marker → panel auto-opens a web tab
    const marker = await postJson("http://localhost:10141/api/browser", {
      url: "https://example.com/", title: "Example smoke",
    });
    console.log("marker posted:", marker.id, marker.url);

    const tabLabel = await waitFor(async () => page.evaluate(() => {
      const spans = [...document.querySelectorAll("span")];
      const s = spans.find((x) => x.textContent && x.textContent.includes("example.com"));
      return s ? s.textContent : null;
    }), 30000, "web tab opened with hostname label");
    console.log("web tab label:", tabLabel);

    // 2. iframe loads the proxied page
    await waitFor(async () => page.evaluate(() => {
      const f = document.querySelector("iframe");
      if (!f) return false;
      const src = f.getAttribute("src") || "";
      return src.startsWith("/api/browser/proxy?url=");
    }), 15000, "iframe points at proxy");
    console.log("iframe proxied src: true");

    // 3. Address-bar navigation to a second page — hard requirement (also
    //    proves the panel stays mounted and interactive after initial load).
    const inputFound = await waitFor(async () => page.evaluate(() => {
      const input = document.querySelector('input[type="text"]');
      return input ? (input.placeholder || input.getAttribute("aria-label") || "") : null;
    }), 10000, "address bar input");
    console.log("address bar input placeholder:", inputFound);

    await page.evaluate(() => {
      const input = document.querySelector('input[type="text"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, "example.org");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => {
      const form = document.querySelector("form");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const navigated = await waitFor(async () => page.evaluate(() => {
      const f = document.querySelector("iframe");
      const src = f ? (f.getAttribute("src") || "") : "";
      return src.includes("example.org") ? src : null;
    }), 15000, "address-bar navigation");
    console.log("navigated to:", navigated);

    console.log("SMOKE_OK");
  } finally {
    // clear any lingering marker
    try {
      const req = http.request("http://localhost:10141/api/browser", { method: "DELETE" }, () => {});
      req.on("error", () => {});
      req.end();
    } catch { /* ignore */ }
    await browser.close();
  }
})().catch((e) => { console.error("SMOKE_FAIL:", e.message); process.exit(1); });
