import puppeteer from "puppeteer-core";
import http from "node:http";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function postJson(url, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
    req.on("error", rej);
    req.end(data);
  });
}
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--disable-extensions", "--disable-gpu", "--no-first-run", "--window-size=1600,1000"] });
  try {
    const page = await browser.newPage();
    let t0 = Date.now();
    page.on("request", (r) => { if (r.url().includes("/api/browser")) console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] REQ ${r.method()} ${r.url().slice(-30)}`); });
    page.on("response", async (r) => { if (r.url().endsWith("/api/browser") && r.request().method() === "GET") { try { console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] RES ${(await r.text()).slice(0, 70)}`); } catch {} } });
    page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));
    await page.goto("http://localhost:10141/", { waitUntil: "domcontentloaded" });
    await sleep(4000);
    const mounted = await page.evaluate(() => !!document.querySelector("#file-panel"));
    console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] app mounted:`, mounted);
    const resp = await postJson("http://localhost:10141/api/browser", { url: "https://example.com/", title: "T" });
    console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] marker posted:`, resp.id);
    await sleep(10000);
    const state = await page.evaluate(() => ({
      panel: document.querySelector("#file-panel")?.className?.includes("right-panel-open") ?? false,
      webTabs: document.querySelectorAll('#file-panel input[type="text"]').length,
    }));
    console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] final state:`, JSON.stringify(state));
  } finally { await browser.close(); }
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
