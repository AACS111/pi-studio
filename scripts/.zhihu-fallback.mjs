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
    await page.goto("http://localhost:10141/", { waitUntil: "domcontentloaded" });
    await sleep(4000);
    // 先让侧车打开知乎（控制台模式需要侧车已在该页面）
    const url = "https://www.zhihu.com/question/2068854631464227633/answer/2069563885909185291";
    await postJson("http://localhost:10141/api/browser", { url, title: "知乎 A 股" });
    console.log("marker posted (zhihu)");
    await sleep(6000);
    const state1 = await page.evaluate(() => ({
      panelOpen: document.querySelector("#file-panel")?.className?.includes("right-panel-open") ?? false,
      consoleMode: [...document.querySelectorAll("#file-panel button")].some((b) => b.textContent.trim().includes("Agent") && b.getAttribute("aria-pressed") === "true"),
      consoleShot: [...document.querySelectorAll("#file-panel img")].some((i) => (i.getAttribute("src")||"").startsWith("data:image/png")),
      fallbackMsg: document.body.innerText.includes("反爬") || document.body.innerText.includes("anti-bot"),
    }));
    console.log("after marker:", JSON.stringify(state1));
    await sleep(3000);
    const state2 = await page.evaluate(() => ({
      consoleShot: [...document.querySelectorAll("#file-panel img")].some((i) => (i.getAttribute("src")||"").startsWith("data:image/png")),
      urlBar: document.querySelector('#file-panel input[type="text"]') ? document.querySelector('#file-panel input[type="text"]').value.slice(0, 60) : null,
    }));
    console.log("later:", JSON.stringify(state2));
  } finally { await browser.close(); }
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
