"""E2E: pi-studio right-panel mirror via direct CDP screencast.

Drives a real headless Chrome against the pi-studio UI: opens a web tab
(globe button), then observes from INSIDE the page (monkeypatched WebSocket)
that the panel connected directly to the browser-use sidecar's Chrome CDP
port and receives Page.screencastFrame frames. Screenshots the mirror panel
before/after navigating the sidecar browser to prove live updates.
"""
import asyncio, json, urllib.request, base64, sys, websockets

TEST = "http://127.0.0.1:50201"
OUT_DIR = "tools/browser-use-server"


def get_page_ws():
    targets = json.loads(urllib.request.urlopen(f"{TEST}/json", timeout=3).read())
    return [t for t in targets if t["type"] == "page"][0]["webSocketDebuggerUrl"]


GLOBE_JS = (
    "(() => { const b=[...document.querySelectorAll('button')].find(x => {"
    "  const c = x.querySelector('svg circle');"
    "  const p = x.querySelector('svg path');"
    "  const d = p ? (p.getAttribute('d') || '') : '';"
    "  return c && p && d.includes('15.3');"
    "}); return b ? 'found' : 'none'; })()"
)

CLICK_JS = (
    "(() => { const b=[...document.querySelectorAll('button')].find(x => {"
    "  const c = x.querySelector('svg circle');"
    "  const p = x.querySelector('svg path');"
    "  const d = p ? (p.getAttribute('d') || '') : '';"
    "  return c && p && d.includes('15.3');"
    "}); if (b) b.click(); return b ? 'ok' : 'none'; })()"
)


async def main():
    mid = 0
    pending = {}

    async with websockets.connect(get_page_ws(), open_timeout=5) as ws:
        async def pump():
            while True:
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=0.25))
                except asyncio.TimeoutError:
                    continue
                if "id" in msg and msg["id"] in pending:
                    pending.pop(msg["id"]).set_result(msg)
        pump_task = asyncio.create_task(pump())

        async def send(method, params=None, timeout=15):
            nonlocal mid
            mid += 1
            fut = asyncio.get_event_loop().create_future()
            pending[mid] = fut
            await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            return await asyncio.wait_for(fut, timeout=timeout)

        async def evaluate(expression, timeout=8):
            r = await send("Runtime.evaluate", {"expression": expression, "returnByValue": True}, timeout=timeout)
            return r.get("result", {}).get("result", {}).get("value")

        async def screenshot(name):
            nonlocal mid
            mid += 1
            fut = asyncio.get_event_loop().create_future()
            pending[mid] = fut
            await ws.send(json.dumps({"id": mid, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
            r = await asyncio.wait_for(fut, timeout=15)
            data = r.get("result", {}).get("data", "")
            path = f"{OUT_DIR}/{name}"
            with open(path, "wb") as f:
                f.write(base64.b64decode(data))
            return len(data), path

        await send("Page.enable")
        await send("Runtime.enable")
        await send("Page.navigate", {"url": "http://localhost:10141"})
        await asyncio.sleep(5)

        # inject WebSocket probe
        await evaluate("""(() => {
          window.__wsLog = [];
          const Orig = window.WebSocket;
          window.WebSocket = class extends Orig {
            constructor(url, protocols) {
              super(url, protocols);
              window.__wsLog.push({url, state: 'created', t: Date.now()});
              const id = window.__wsLog.length - 1;
              this.addEventListener('open', () => { window.__wsLog[id].state = 'open'; });
              this.addEventListener('message', (e) => {
                const s = String(e.data);
                window.__wsLog[id].frames = (window.__wsLog[id].frames || 0) + (s.includes('screencastFrame') ? 1 : 0);
                if (s.includes('screencastFrame') && window.__wsLog[id].firstFrame === undefined) {
                  window.__wsLog[id].firstFrame = s.slice(0, 100);
                }
              });
              this.addEventListener('close', () => { window.__wsLog[id].state = 'closed'; });
              this.addEventListener('error', () => { window.__wsLog[id].state = 'error'; });
            }
          };
          return 'probe installed';
        })()""")

        print("globe:", await evaluate(GLOBE_JS))
        await evaluate(CLICK_JS)

        for _ in range(30):
            await asyncio.sleep(0.5)
            state = await evaluate("JSON.stringify(window.__wsLog)")
            if state and '"open"' in state:
                break
        log = await evaluate("JSON.stringify(window.__wsLog)")
        print("ws log:", log)
        imgs = await evaluate(
            "(() => [...document.querySelectorAll('img')].map(i => ({src: i.src.slice(0, 22), w: i.naturalWidth, h: i.naturalHeight})))()")
        print("mirror imgs:", imgs)
        n1, p1 = await screenshot("e2e-mirror.png")
        print("screenshot1:", n1, "b64 ->", p1)

        # navigate the sidecar browser, confirm mirror updates
        urllib.request.urlopen(urllib.request.Request(
            "http://127.0.0.1:17865/open",
            data=json.dumps({"url": "https://example.org"}).encode(),
            headers={"Content-Type": "application/json"}), timeout=20).read()
        await asyncio.sleep(3)
        log2 = await evaluate("JSON.stringify(window.__wsLog)")
        print("ws log after sidecar nav:", log2)
        n2, p2 = await screenshot("e2e-mirror2.png")
        print("screenshot2:", n2, "b64 ->", p2)
        pump_task.cancel()


asyncio.run(main())
