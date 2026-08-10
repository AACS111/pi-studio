"use strict";

/**
 * 原生浏览器控制桥（Electron 主进程内嵌 WebContentsView）。
 *
 * 提供与 browser-use 侧车兼容的 HTTP 接口（127.0.0.1，随机端口），
 * 让 Next 服务 / agent 用同一套 /api/browser/control/* 语义控制右侧
 * 原生浏览器：open/back/forward/reload/content/screenshot/click/type/
 * press/scroll/input。
 *
 * 与截图镜像不同，这里没有帧编码/传输：页面由 Electron 直接合成，
 * 控制命令通过 webContents.executeJavaScript / CDP 落到同一个页面。
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOAD_TIMEOUT_MS = 15000;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, err) {
  const status = err && Number.isInteger(err.status) ? err.status : 500;
  sendJson(res, status, { error: err && err.message ? err.message : String(err) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function requireActive(getActiveView) {
  const wc = getActiveView();
  if (!wc || wc.isDestroyed()) {
    const err = new Error("browser not started");
    err.status = 503;
    throw err;
  }
  return wc;
}

function currentInfo(wc) {
  return {
    url: wc.getURL() || null,
    title: wc.getTitle() || null,
  };
}

function waitForLoad(wc, trigger, timeoutMs = LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error("Page load timed out");
      err.status = 504;
      reject(err);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", onFinish);
      wc.removeListener("did-fail-load", onFail);
    };
    const onFinish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onFail = (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || settled) return;
      settled = true;
      cleanup();
      const err = new Error(`Page load failed: ${description} (${code})`);
      err.status = 504;
      reject(err);
    };

    wc.once("did-finish-load", onFinish);
    wc.once("did-fail-load", onFail);
    try {
      trigger();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

async function withDebugger(wc, fn) {
  const wasAttached = wc.debugger.isAttached();
  if (!wasAttached) wc.debugger.attach("1.3");
  try {
    return await fn();
  } finally {
    if (!wasAttached && wc.debugger.isAttached()) wc.debugger.detach();
  }
}

async function evaluate(wc, expression) {
  return wc.executeJavaScript(expression, true);
}

function findElementJs(selector) {
  const q = JSON.stringify(String(selector ?? "").trim());
  return `(() => {
    const root = document;
    let el = root.querySelector(${q});
    if (!el) {
      const candidates = root.querySelectorAll(
        'button,a,input,textarea,select,label,[role="button"],[role="link"],[onclick]'
      );
      const needle = String(${q}).toLowerCase();
      for (const node of candidates) {
        const text = ((node.innerText || node.value || node.getAttribute('aria-label') || '') + '').trim();
        if (text && text.toLowerCase().includes(needle)) { el = node; break; }
      }
    }
    return el;
  })()`;
}

async function screenshotPng(wc, fullPage) {
  try {
    const data = await withDebugger(wc, async () => {
      const res = await wc.debugger.sendCommand("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: Boolean(fullPage),
      });
      return res && res.data ? res.data : null;
    });
    if (data) return Buffer.from(data, "base64");
  } catch {
    /* fall back to native capture below */
  }
  const image = await wc.capturePage();
  return image.toPNG();
}

function normalizeKey(key) {
  const map = {
    enter: "Enter",
    return: "Enter",
    escape: "Escape",
    esc: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    f5: "F5",
  };
  return map[String(key ?? "").toLowerCase().trim()] || null;
}

function keyParams(keyName) {
  const table = {
    Enter: { code: "Enter", vk: 13 },
    Escape: { code: "Escape", vk: 27 },
    Tab: { code: "Tab", vk: 9 },
    Backspace: { code: "Backspace", vk: 8 },
    Delete: { code: "Delete", vk: 46 },
    ArrowUp: { code: "ArrowUp", vk: 38 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
    ArrowLeft: { code: "ArrowLeft", vk: 37 },
    ArrowRight: { code: "ArrowRight", vk: 39 },
    Home: { code: "Home", vk: 36 },
    End: { code: "End", vk: 35 },
    PageUp: { code: "PageUp", vk: 33 },
    PageDown: { code: "PageDown", vk: 34 },
    F5: { code: "F5", vk: 116 },
  };
  return table[keyName] || { code: keyName, vk: 0 };
}

async function dispatchInput(wc, body) {
  const type = String(body.type || "").toLowerCase();
  const button = String(body.button || "left").toLowerCase();

  if (type === "click" || type === "press" || type === "release") {
    if (body.x == null || body.y == null) {
      const err = new Error(`${type} needs x/y`);
      err.status = 400;
      throw err;
    }
    const clickCount = Number(body.clickCount || 1);
    const eventType = type === "click" ? ["mousePressed", "mouseReleased"] : type === "press" ? ["mousePressed"] : ["mouseReleased"];
    await withDebugger(wc, async () => {
      for (const etype of eventType) {
        const params = {
          type: etype,
          x: body.x,
          y: body.y,
          button,
          clickCount,
        };
        if (type === "press") params.buttons = button === "right" ? 2 : button === "middle" ? 4 : 1;
        if (type === "release") params.buttons = 0;
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", params);
      }
    });
    return { ok: true };
  }

  if (type === "move") {
    if (body.x == null || body.y == null) {
      const err = new Error("move needs x/y");
      err.status = 400;
      throw err;
    }
    const params = { type: "mouseMoved", x: body.x, y: body.y };
    if (body.buttons) params.buttons = Number(body.buttons);
    await withDebugger(wc, () => wc.debugger.sendCommand("Input.dispatchMouseEvent", params));
    return { ok: true };
  }

  if (type === "scroll") {
    await withDebugger(wc, () =>
      wc.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Number(body.x || 0),
        y: Number(body.y || 0),
        deltaX: Number(body.delta_x || 0),
        deltaY: Number(body.delta_y || 0),
      })
    );
    return { ok: true };
  }

  if (type === "key") {
    const keyName = normalizeKey(body.key);
    if (!keyName) {
      const err = new Error(`Unsupported key: ${body.key}`);
      err.status = 400;
      throw err;
    }
    const { code, vk } = keyParams(keyName);
    await withDebugger(wc, async () => {
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: keyName,
        code,
        windowsVirtualKeyCode: vk,
      });
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: keyName,
        code,
        windowsVirtualKeyCode: vk,
      });
    });
    return { ok: true };
  }

  if (type === "type") {
    if (!body.text) {
      const err = new Error("type needs text");
      err.status = 400;
      throw err;
    }
    await withDebugger(wc, () => wc.debugger.sendCommand("Input.insertText", { text: String(body.text) }));
    return { ok: true };
  }

  const err = new Error(`Unsupported input type: ${body.type}`);
  err.status = 400;
  throw err;
}

function writeBridgeMarker(dataDir, baseUrl, port) {
  if (!dataDir) return;
  try {
    const internal = path.join(dataDir, ".internal");
    fs.mkdirSync(internal, { recursive: true });
    fs.writeFileSync(
      path.join(internal, "pi-web-browser-bridge.json"),
      JSON.stringify(
        {
          mode: "electron-webview",
          baseUrl,
          port,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );
  } catch {
    /* marker is best-effort */
  }
}

function startBridge({ getActiveView, getDownloads, dataDir }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const pathname = url.pathname.replace(/\/+$/, "") || "/";
        const method = req.method || "GET";

        if (method === "GET" && pathname === "/health") {
          const wc = getActiveView();
          const running = Boolean(wc && !wc.isDestroyed());
          return sendJson(res, 200, { ok: true, browser: running ? "running" : "not_started", mode: "electron-webview" });
        }

        if (method === "GET" && pathname === "/downloads") {
          return sendJson(res, 200, {
            downloads: typeof getDownloads === "function" ? getDownloads() : [],
          });
        }

        if (method === "GET" && pathname === "/url") {
          const wc = requireActive(getActiveView);
          return sendJson(res, 200, currentInfo(wc));
        }

        if (method === "POST" && pathname === "/open") {
          const body = await readBody(req);
          let target;
          try {
            target = new URL(String(body.url || ""));
          } catch {
            const err = new Error("Invalid URL");
            err.status = 400;
            throw err;
          }
          if (!["http:", "https:"].includes(target.protocol)) {
            const err = new Error("Only http(s) URLs are supported");
            err.status = 400;
            throw err;
          }
          const wc = requireActive(getActiveView);
          await waitForLoad(wc, () => wc.loadURL(target.href));
          return sendJson(res, 200, currentInfo(wc));
        }

        if (method === "POST" && ["/back", "/forward"].includes(pathname)) {
          const wc = requireActive(getActiveView);
          const isBack = pathname === "/back";
          const canMove = isBack ? wc.canGoBack() : wc.canGoForward();
          if (!canMove) return sendJson(res, 200, { ok: true, moved: false });
          await waitForLoad(wc, () => (isBack ? wc.goBack() : wc.goForward()));
          return sendJson(res, 200, { ok: true, moved: true });
        }

        if (method === "POST" && pathname === "/reload") {
          const wc = requireActive(getActiveView);
          await waitForLoad(wc, () => wc.reload());
          return sendJson(res, 200, { ok: true });
        }

        if (method === "GET" && pathname === "/content") {
          const wc = requireActive(getActiveView);
          const maxChars = Number(url.searchParams.get("max_chars") || 60000) || 60000;
          const result = await evaluate(
            wc,
            `(() => {
              const root = document.body || document.documentElement;
              const text = root ? (root.innerText || root.textContent || '') : '';
              const links = Array.from(document.querySelectorAll('a[href]'))
                .map((a) => a.href).filter(Boolean).slice(0, 200);
              return { text, links, title: document.title };
            })()`
          );
          let content = String(result && result.text ? result.text : "");
          if (content.length > maxChars) content = content.slice(0, maxChars) + "\n…[truncated]";
          return sendJson(res, 200, {
            url: wc.getURL() || null,
            title: wc.getTitle() || null,
            content,
            stats: { method: "innerText", chars: content.length, links: (result && result.links || []).length },
          });
        }

        if (method === "GET" && pathname === "/screenshot") {
          const wc = requireActive(getActiveView);
          const fullPage = url.searchParams.get("full_page") === "true";
          const png = await screenshotPng(wc, fullPage);
          if (url.searchParams.get("json") === "1") {
            return sendJson(res, 200, { png_base64: png.toString("base64") });
          }
          res.writeHead(200, {
            "content-type": "image/png",
            "cache-control": "no-store",
            "content-length": png.length,
          });
          return res.end(png);
        }

        if (method === "POST" && pathname === "/click") {
          const body = await readBody(req);
          const wc = requireActive(getActiveView);
          const expr = `(() => {
            const el = ${findElementJs(body.selector)};
            if (!el) return { found: false };
            el.scrollIntoView({ block: 'center' });
            el.click();
            return { found: true, tag: el.tagName, text: (el.innerText || '').slice(0, 80) };
          })()`;
          const value = await evaluate(wc, expr);
          if (!value || !value.found) {
            const err = new Error(`Element not found: ${body.selector}`);
            err.status = 404;
            throw err;
          }
          return sendJson(res, 200, { ok: true, tag: value.tag, text: value.text });
        }

        if (method === "POST" && pathname === "/type") {
          const body = await readBody(req);
          const wc = requireActive(getActiveView);
          const clear = Boolean(body.clear);
          const text = JSON.stringify(String(body.text || ""));
          const expr = `(() => {
            const el = ${findElementJs(body.selector)};
            if (!el) return { found: false };
            el.focus();
            if (${clear}) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
                || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
              if (setter && setter.set) setter.set.call(el, '');
              else el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const text = ${text};
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
              || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
            if (setter && setter.set) setter.set.call(el, el.value + text);
            else el.value = el.value + text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { found: true, value: el.value.slice(0, 80) };
          })()`;
          const value = await evaluate(wc, expr);
          if (!value || !value.found) {
            const err = new Error(`Element not found: ${body.selector}`);
            err.status = 404;
            throw err;
          }
          return sendJson(res, 200, { ok: true, value: value.value });
        }

        if (method === "POST" && pathname === "/press") {
          const body = await readBody(req);
          const wc = requireActive(getActiveView);
          const key = normalizeKey(body.key);
          if (!key) {
            const err = new Error(`Unsupported key: ${body.key}`);
            err.status = 400;
            throw err;
          }
          if (key === "Enter") {
            await evaluate(
              wc,
              `(() => {
                const el = document.activeElement;
                if (!el) return { found: false };
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                const form = el.closest('form');
                if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                return { found: true };
              })()`
            );
          } else {
            await dispatchInput(wc, { type: "key", key: body.key });
          }
          return sendJson(res, 200, { ok: true });
        }

        if (method === "POST" && pathname === "/scroll") {
          const body = await readBody(req);
          const wc = requireActive(getActiveView);
          const direction = String(body.direction || "").toLowerCase();
          let js;
          if (direction === "top") js = "window.scrollTo(0, 0)";
          else if (direction === "bottom") js = "window.scrollTo(0, document.body.scrollHeight)";
          else if (direction === "up") js = "window.scrollBy(0, -window.innerHeight * 0.8)";
          else if (direction === "down") js = "window.scrollBy(0, window.innerHeight * 0.8)";
          else {
            const err = new Error(`Invalid direction: ${body.direction}`);
            err.status = 400;
            throw err;
          }
          await evaluate(wc, `(() => { ${js}; return { ok: true }; })()`);
          return sendJson(res, 200, { ok: true });
        }

        if (method === "POST" && pathname === "/input") {
          const body = await readBody(req);
          const wc = requireActive(getActiveView);
          const result = await dispatchInput(wc, body);
          return sendJson(res, 200, result);
        }

        if (method === "POST" && pathname === "/close") {
          return sendJson(res, 200, { ok: true });
        }

        if (method === "POST" && pathname === "/agent") {
          const err = new Error("LLM-driven /agent is not available on the native Electron webview yet");
          err.status = 501;
          throw err;
        }

        sendJson(res, 404, { error: `Not found: ${method} ${pathname}` });
      } catch (err) {
        sendError(res, err);
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      writeBridgeMarker(dataDir, baseUrl, port);
      resolve({ port, baseUrl, server });
    });
  });
}

module.exports = { startBridge };
