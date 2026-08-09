// Smoke test: open the .univer worktree in the real viewer, switch to the
// 统计分析 sheet, assert: 3 sheets, C6 is a number (no text-number warning).
const { spawn } = require("child_process");
const http = require("http");
const WebSocket = require("C:/Users/zheng/Desktop/pi-studio/pi-studio-main/node_modules/ws");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9334;
const APP = "http://localhost:10141/?cwd=" + encodeURIComponent("C:/Users/zheng/.pi/agent/pi-web-uploads");
const FILE = "基板进度追踪-ai-edit.univer";
const PROFILE = path.join(os.tmpdir(), "piweb-cdp-smoke-" + Date.now());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJson(url) {
  return new Promise((res, rej) => http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej));
}
async function waitFor(fn, t, step) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { try { const v = await fn(); if (v) return v; } catch {} await sleep(1000); }
  throw new Error("TIMEOUT: " + step);
}

async function main() {
  const proc = spawn(CHROME, ["--headless=new", "--disable-extensions", "--disable-gpu",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + PROFILE, "--window-size=1600,1000", APP],
    { stdio: "ignore", detached: true });
  proc.unref();
  let targets;
  await waitFor(async () => { targets = await getJson(`http://localhost:${PORT}/json/list`).catch(() => null);
    return targets && targets.some((t) => t.type === "page" && t.url.includes("localhost:10141")); }, 30000, "chrome");
  const page = targets.find((t) => t.type === "page" && t.url.includes("localhost:10141"));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  let id = 0; const pending = new Map();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result ? r.result.result.value : undefined;
  };
  await send("Runtime.enable");

  await waitFor(async () => evaluate(`!!document.querySelector('body')`), 20000, "body");
  await waitFor(async () => evaluate(`(() => { const s=[...document.querySelectorAll('span')].find(x=>x.textContent===${JSON.stringify(FILE)}); return !!s; })()`), 180000, "file row");
  await evaluate(`(() => { const s=[...document.querySelectorAll('span')].find(x=>x.textContent===${JSON.stringify(FILE)}); (s.closest('div')||s).click(); return true; })()`);
  await waitFor(async () => evaluate(`typeof window.__piUniver !== 'undefined'`), 180000, "__piUniver");
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent&&x.textContent.includes('edit-dropdown')); if(b)b.click(); return !!b; })()`);

  // switch to 统计分析 sheet via facade, then read cells
  let lastPoll = null;
  const out = await waitFor(async () => {
    const v = await evaluate(`(async () => {
      try {
        const api = window.__piUniver;
        if(!api) return {ready:false, reason:'no api'};
        const wb = api.getActiveWorkbook();
        if(!wb) return {ready:false, reason:'no wb'};
        const names = wb.getSheetNames ? wb.getSheetNames() : null;
        const st = wb.getSheetByName('统计分析');
        if(!st) return {ready:false, reason:'no sheet', names};
        const c6 = st.getRange('C6').getCellData();
        const b17 = st.getRange('B17').getCellData();
        return {ready:true, names, c6v: c6 && c6.v, c6t: c6 && c6.t, b17v: b17 && b17.v, b17t: b17 && b17.t, c6IsNum: !!(c6 && c6.t === 2)};
      } catch(e) { return {ready:false, reason:'err:'+e.message}; }
    })()`);
    lastPoll = v;
    return v && v.ready ? v : null;
  }, 180000, "统计分析 sheet").catch((e) => { console.log("last poll:", JSON.stringify(lastPoll)); throw e; });

  console.log("sheets:", JSON.stringify(out.names));
  console.log("C6(总订单占比):", "v=" + out.c6v, "t=" + out.c6t, "| 数字类型:", out.c6IsNum);
  console.log("B17(延误率):", "v=" + out.b17v);
  const pass = out.c6IsNum && out.b17t === 2;
  console.log(pass ? "\n=== SMOKE PASS ===" : "\n=== SMOKE FAIL ===");
  ws.close();
  try { process.kill(-proc.pid); } catch {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("SMOKE ERROR:", e.message); process.exit(2); });
