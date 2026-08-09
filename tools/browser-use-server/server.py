"""
browser-use 控制侧车服务（FastAPI, 127.0.0.1:17865）

让 pi agent（Node 侧）通过 HTTP 控制一个真实浏览器（Chrome，经 browser-use
的 BrowserSession/CDP 驱动），用于：
  - 控制浏览器：打开页面、点击、输入、按键、滚动、后退/前进/刷新
  - 诊断内容：提取页面纯净 Markdown（extract_clean_markdown）、截图、URL/标题
  - LLM 驱动：把任务交给 browser-use Agent（OpenAI 兼容接口，可对接 pi 的模型配置）
  - 实时镜像：/screencast SSE 推流 + /input CDP 输入注入（右侧面板即真实浏览器）

浏览器会话自愈：CDP 往返探活，Chrome 意外退出/卡死时自动销毁旧会话并重建，
请求不挂起（配合 get_cdp() 的竞态重试）。

启动：
  tools/browser-use-server/start.bat        （或）
  tools/browser-use-server/.venv/Scripts/python.exe tools/browser-use-server/server.py

端口：17865（环境变量 PI_BROWSER_USE_PORT 可覆盖）
默认 headless（面板实时镜像即窗口）；PI_BROWSER_USE_HEADLESS=0 恢复有头。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 环境准备：让 browser-use 使用系统 Chrome（避免下载浏览器）
# ---------------------------------------------------------------------------
CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]


def _find_chrome() -> str | None:
    env = os.environ.get("CHROME_PATH") or os.environ.get("BH_CHROME_PATH")
    if env and Path(env).exists():
        return env
    for cand in CHROME_CANDIDATES:
        if Path(cand).exists():
            return cand
    return None

if not os.environ.get("CHROME_PATH") and not os.environ.get("BH_CHROME_PATH"):
    found = _find_chrome()
    if found:
        os.environ["CHROME_PATH"] = found
        os.environ["BH_CHROME_PATH"] = found

# 本地日志
LOG_PATH = Path(__file__).resolve().parent / "server.log"
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler(LOG_PATH, encoding="utf-8")],
)
log = logging.getLogger("browser-use-server")

# 强制 UTF-8（browser-use 内部日志写控制台时用默认 GBK 编码会崩，见 _zhihu-test 复现）
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import subprocess  # noqa: E402
import socket  # noqa: E402
import urllib.request  # noqa: E402
import time as _time  # noqa: E402

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import JSONResponse, Response, StreamingResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from browser_use.browser.session import BrowserSession  # noqa: E402
from browser_use.dom.markdown_extractor import extract_clean_markdown  # noqa: E402

app = FastAPI(title="browser-use sidecar", version="1.0.0")


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    """把未捕获异常记录到 server.log（含 traceback），返回 JSON 而非裸 500。"""
    import traceback

    log.error(
        "Unhandled exception on %s %s: %s\n%s",
        request.method, request.url.path, exc, traceback.format_exc(),
    )
    return JSONResponse(status_code=500, content={"detail": str(exc)})

# ---------------------------------------------------------------------------
# 全局浏览器会话（懒启动、跨请求复用）
# ---------------------------------------------------------------------------
_browser: BrowserSession | None = None
_lock = asyncio.Lock()


_chrome_proc: subprocess.Popen | None = None


def _pick_free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _launch_clean_chrome(profile_root: Path) -> str:
    """手动启动干净 Chrome（无自动化标记），返回 CDP URL。

    用 browser-use 默认启动器时，Chrome 会带 --disable-web-security / --single-process /
    --deterministic-mode 等一堆可被反爬识别为自动化的参数；知乎的 zse-ck 就是靠这些
    拦 headless/自动化浏览器。这里手动用干净参数启动（只保留 remote-debugging + 隐藏
    navigator.webdriver），再通过 cdp_url 连接，和 Codex 用真实浏览器的行为一致。
    """
    exe = _find_chrome()
    if not exe:
        raise HTTPException(status_code=500, detail="Chrome/Edge not found — install Chrome or set CHROME_PATH")
    # 默认 headless：浏览器被「内嵌」到 pi-web 右侧面板的实时镜像里（SSE 推流 + 输入注入），
    # 不再弹出可见窗口（有头窗口易被用户误关导致会话僵死）。反爬需要时可设
    # PI_BROWSER_USE_HEADLESS=0 恢复有头。
    headless = os.environ.get("PI_BROWSER_USE_HEADLESS", "1") == "1"
    port = _pick_free_port()
    args = [
        exe,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile_root}",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,900",
    ]
    if headless:
        args.append("--headless=new")
    args.append("about:blank")
    log.info("Launching clean Chrome: %s (headless=%s, port=%s)", exe, headless, port)
    try:
        global _chrome_proc
        _chrome_proc = subprocess.Popen(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Chrome launch failed: {e}") from e
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as r:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2).close() if False else None
                _ = r.read()
                return f"http://127.0.0.1:{port}"
        except Exception:  # noqa: BLE001
            _time.sleep(0.5)
    raise HTTPException(status_code=500, detail="Chrome CDP did not become ready")


async def _probe_alive(browser: BrowserSession) -> bool:
    """快速 CDP 往返探活：3 秒内没响应就当会话已死。

    必须是**真实 CDP 命令往返**——只调 get_current_page_url() 不够：断线重连期间
    它可能返回缓存 URL（看起来活着），但实际 CDP 客户端已死，后续任何真实操作都会
    抛 "Client is not started" 或永久挂起。
    """
    try:
        result = await asyncio.wait_for(
            browser.cdp_client.send_raw(method="Browser.getVersion", params={}, session_id=None),
            timeout=3,
        )
        return bool(result)
    except Exception:  # noqa: BLE001
        return False


async def get_browser() -> BrowserSession:
    """懒启动干净 Chrome 并连接；会话僵死/断开时自动销毁重建（自愈）。

    默认 headless（浏览器内嵌在 pi-web 右侧面板的实时镜像里）；设
    PI_BROWSER_USE_HEADLESS=0 可恢复有头真实窗口（反爬更强的场景）。
    """
    global _browser
    async with _lock:
        if _browser is not None:
            if await _probe_alive(_browser):
                return _browser
            log.warning("Browser session stale/dead — tearing down and relaunching")
            try:
                await _browser.stop()
            except Exception:  # noqa: BLE001
                pass
            _browser = None
        profile_root = Path(__file__).resolve().parent / ".browser-profile"
        profile_root.mkdir(parents=True, exist_ok=True)
        try:
            cdp_url = _launch_clean_chrome(profile_root)
            session = BrowserSession(cdp_url=cdp_url)
            await session.start()
        except Exception as e:  # noqa: BLE001
            log.error("Browser launch failed: %s", e)
            _browser = None
            raise HTTPException(status_code=500, detail=f"Browser launch failed: {e}") from e
        _browser = session
        log.info("Browser started (cdp=%s)", session.cdp_url)
        return _browser


async def _page_cdp_once():
    """绑定到当前页面 target，返回 (browser, cdp_session)。"""
    browser = await get_browser()
    page = await asyncio.wait_for(browser.get_current_page(), timeout=8)
    if page is None:
        await asyncio.wait_for(browser.new_page(), timeout=8)
        page = await asyncio.wait_for(browser.get_current_page(), timeout=8)
    # 绑定到当前页面 target（get_or_create_cdp_session 默认用 agent focus，导航后可能指向旧目标）
    cdp = await asyncio.wait_for(
        browser.get_or_create_cdp_session(target_id=page._target_id), timeout=8
    )
    return browser, cdp


async def get_cdp():
    """返回 (browser, 绑定到当前页面 target 的 cdp_session)。

    先经 get_browser() 探活（已含自愈），再给每个 CDP 调用加超时；若探活通过后
    会话竞态死亡（CDP 调用报 "Client is not started" 等），强制销毁重建后重试一次，
    保证任何情况下都不会永久挂起。
    """
    try:
        return await _page_cdp_once()
    except Exception:  # noqa: BLE001
        global _browser
        async with _lock:
            if _browser is not None:
                try:
                    await asyncio.wait_for(_browser.stop(), timeout=5)
                except Exception:  # noqa: BLE001
                    pass
                _browser = None
        return await _page_cdp_once()


async def _evaluate(expression: str, cdp) -> dict:
    """执行页面内 JS，返回 CDP 结果 dict。"""
    result = await asyncio.wait_for(
        cdp.cdp_client.send.Runtime.evaluate(
            params={"expression": expression, "returnByValue": True, "awaitPromise": True},
            session_id=cdp.session_id,
        ),
        timeout=10,
    )
    return result


async def _cdp_send(cdp, method: str, params: dict, timeout: float = 8.0) -> dict:
    """带短超时的 CDP 调用。

    browser-use 的默认超时是 60s——点击必应热点这类 target=_blank 链接时，弹窗会让
    旧 target 的 CDP session 静默挂起（曾观察到 Input.dispatchMouseEvent 挂满 60s），
    面板镜像跟着冻结成白屏。这里统一用 8s 快速失败，由调用方重新绑定 session 后重试。
    """
    return await asyncio.wait_for(
        cdp.cdp_client.send_raw(method=method, params=params, session_id=cdp.session_id),
        timeout=timeout,
    )


async def _ensure_page(browser: BrowserSession, url: str | None = None) -> None:
    page = await asyncio.wait_for(browser.get_current_page(), timeout=8)
    if page is None:
        await asyncio.wait_for(browser.new_page(url), timeout=8)
    elif url:
        await asyncio.wait_for(browser.navigate_to(url), timeout=30)


async def _wait_ready(cdp, timeout: float = 15.0) -> None:
    """轮询 document.readyState === 'complete'，再留 300ms 让渲染/脚本收尾。"""
    import time

    deadline = time.monotonic() + timeout
    while True:
        if time.monotonic() >= deadline:
            break
        try:
            res = await _evaluate("document.readyState", cdp)
            # CDP 返回 {"result": {"type":"string","value":"complete"}}
            state = res.get("result", {}).get("value", "")
            if state == "complete":
                break
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(0.3)
    await asyncio.sleep(0.3)


def _js_escape(text: str) -> str:
    """把 Python 字符串安全嵌入 JS 字符串字面量。"""
    return json_dumps(text)


def json_dumps(text: str) -> str:
    import json

    return json.dumps(text, ensure_ascii=False)


def _find_element_js(selector: str) -> str:
    """构造查找元素的 JS 表达式：优先 CSS 选择器，其次按可见文本匹配。"""
    return f"""(() => {{
      const css = (() => {{
        try {{
          const el = document.querySelector({_js_escape(selector)});
          if (el) return el;
        }} catch (e) {{}}
        return null;
      }})();
      if (css) return css;
      // 按可见文本找（含部分匹配）
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      const needle = {_js_escape(selector)};
      while ((node = walker.nextNode())) {{
        const t = (node.textContent || '').trim();
        if (t && (t === needle || t.includes(needle))) {{
          let el = node.parentElement;
          while (el && el.children.length <= 1 && el.parentElement && el !== document.body) el = el.parentElement;
          return el;
        }}
      }}
      return null;
    }})()"""


# ---------------------------------------------------------------------------
# 模型
# ---------------------------------------------------------------------------


class OpenModel(BaseModel):
    url: str


class ClickModel(BaseModel):
    selector: str
    index: int = 0


class TypeModel(BaseModel):
    selector: str
    text: str
    clear: bool = True


class PressModel(BaseModel):
    key: str  # Enter / Escape / Tab / Backspace / Control+a 等


class ScrollModel(BaseModel):
    direction: str = "down"  # up | down | top | bottom


class AgentLLM(BaseModel):
    model: str = Field(description="模型名，如 gpt-4o-mini")
    api_key: str | None = None
    base_url: str | None = Field(default=None, description="OpenAI 兼容 base_url")


class AgentModel(BaseModel):
    task: str
    llm: AgentLLM | None = None
    max_steps: int = 25
    use_vision: bool = False


# ---------------------------------------------------------------------------
# 状态
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    if _browser is None:
        return {"ok": True, "browser": "not_started"}
    try:
        url = await _browser.get_current_page_url()
        return {"ok": True, "browser": "running", "url": url}
    except Exception as e:  # noqa: BLE001
        return {"ok": True, "browser": "error", "detail": str(e)}


@app.get("/url")
async def current_url():
    browser, _ = await get_cdp()
    try:
        url = await asyncio.wait_for(browser.get_current_page_url(), timeout=8)
        title = await asyncio.wait_for(browser.get_current_page_title(), timeout=8)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"url": url, "title": title}


# ---------------------------------------------------------------------------
# 导航
# ---------------------------------------------------------------------------


@app.post("/open")
async def open_page(body: OpenModel):
    browser, cdp = await get_cdp()
    async with _lock:
        try:
            await _ensure_page(browser, body.url)
            await _wait_ready(cdp, timeout=15000)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail=f"Page load timed out: {body.url}") from None
    try:
        url = await asyncio.wait_for(browser.get_current_page_url(), timeout=8)
        title = await asyncio.wait_for(browser.get_current_page_title(), timeout=8)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"url": url, "title": title}


@app.post("/back")
async def go_back():
    browser, cdp = await get_cdp()
    async with _lock:
        hist = await cdp.cdp_client.send.Page.getNavigationHistory(session_id=cdp.session_id)
        body = hist.get("result", hist) if isinstance(hist, dict) else {}
        current = body.get("currentIndex", -1)
        entries = body.get("entries", [])
        if not isinstance(current, int) or current <= 0 or not entries:
            return {"ok": True, "moved": False}
        await cdp.cdp_client.send.Page.navigateToHistoryEntry(
            params={"entryId": entries[current - 1]["id"]}, session_id=cdp.session_id
        )
        await _wait_ready(cdp, timeout=10000)
    return {"ok": True, "moved": True}


@app.post("/forward")
async def go_forward():
    browser, cdp = await get_cdp()
    async with _lock:
        hist = await cdp.cdp_client.send.Page.getNavigationHistory(session_id=cdp.session_id)
        body = hist.get("result", hist) if isinstance(hist, dict) else {}
        current = body.get("currentIndex", -1)
        entries = body.get("entries", [])
        if not isinstance(current, int) or current < 0 or current >= len(entries) - 1:
            return {"ok": True, "moved": False}
        await cdp.cdp_client.send.Page.navigateToHistoryEntry(
            params={"entryId": entries[current + 1]["id"]}, session_id=cdp.session_id
        )
        await _wait_ready(cdp, timeout=10000)
    return {"ok": True, "moved": True}


@app.post("/reload")
async def reload_page():
    browser, cdp = await get_cdp()
    async with _lock:
        await cdp.cdp_client.send.Page.reload(session_id=cdp.session_id)
        await _wait_ready(cdp, timeout=10000)
    return {"ok": True}


# ---------------------------------------------------------------------------
# 内容诊断
# ---------------------------------------------------------------------------


@app.get("/content")
async def page_content(extract_links: bool = False, max_chars: int = 60000):
    browser, _ = await get_cdp()
    async with _lock:
        try:
            markdown, stats = await extract_clean_markdown(browser, extract_links=extract_links)
        except Exception as e:  # noqa: BLE001
            # 降级：直接取页面文本
            log.warning("extract_clean_markdown failed (%s), falling back to innerText", e)
            markdown, stats = await _fallback_content(browser)
        url = await browser.get_current_page_url()
        title = await browser.get_current_page_title()
    if max_chars and len(markdown) > max_chars:
        markdown = markdown[:max_chars] + "\n…[truncated]"
    return {"url": url, "title": title, "content": markdown, "stats": stats}


async def _fallback_content(browser: BrowserSession):
    cdp = await browser.get_or_create_cdp_session()
    res = await _evaluate(
        "(() => ({ text: document.body ? document.body.innerText.slice(0, 60000) : '', html: document.body ? document.body.innerHTML.length : 0 }))()",
        cdp,
    )
    text = ""
    try:
        text = res.get("result", {}).get("value", {}).get("text", "")
    except Exception:  # noqa: BLE001
        text = ""
    return text, {"method": "innerText"}


@app.get("/screenshot")
async def screenshot(full_page: bool = False, json: bool = False):
    browser, cdp = await get_cdp()
    async with _lock:
        try:
            result = await asyncio.wait_for(
                cdp.cdp_client.send_raw(
                    method="Page.captureScreenshot",
                    params={"format": "png", "captureBeyondViewport": full_page},
                    session_id=cdp.session_id,
                ),
                timeout=15,
            )
            data = base64.b64decode((result or {}).get("data", "")) if isinstance(result, dict) else b""
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=str(e)) from e
    if json:
        return {"png_base64": base64.b64encode(data).decode("ascii")}
    return Response(content=data, media_type="image/png")


# ---------------------------------------------------------------------------
# 交互
# ---------------------------------------------------------------------------


@app.post("/click")
async def click_element(body: ClickModel):
    browser, cdp = await get_cdp()
    async with _lock:
        expr = _find_element_js(body.selector)
        res = await _evaluate(
            f"""(() => {{
              const list = []; const el = {expr};
              if (!el) return {{ found: false }};
              el.scrollIntoView({{ block: 'center' }});
              el.click();
              return {{ found: true, tag: el.tagName, text: (el.innerText || '').slice(0, 80) }};
            }})()""",
            cdp,
        )
        try:
            value = res.get("result", {}).get("value", {})
        except Exception:  # noqa: BLE001
            value = {}
        if not value.get("found"):
            raise HTTPException(status_code=404, detail=f"Element not found: {body.selector}")
        await _wait_ready(cdp, timeout=8000)
    return {"ok": True, "tag": value.get("tag"), "text": value.get("text")}


@app.post("/type")
async def type_text(body: TypeModel):
    browser, cdp = await get_cdp()
    async with _lock:
        expr = _find_element_js(body.selector)
        res = await _evaluate(
            f"""(() => {{
              const el = {expr};
              if (!el) return {{ found: false }};
              el.focus();
              if ({'true' if body.clear else 'false'}) {{
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
                  || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
                if (setter && setter.set) setter.set.call(el, '');
                else el.value = '';
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
              }}
              const text = {_js_escape(body.text)};
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
                || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
              if (setter && setter.set) setter.set.call(el, el.value + text);
              else el.value = el.value + text;
              el.dispatchEvent(new Event('input', {{ bubbles: true }}));
              el.dispatchEvent(new Event('change', {{ bubbles: true }}));
              return {{ found: true, value: el.value.slice(0, 80) }};
            }})()""",
            cdp,
        )
        try:
            value = res.get("result", {}).get("value", {})
        except Exception:  # noqa: BLE001
            value = {}
        if not value.get("found"):
            raise HTTPException(status_code=404, detail=f"Element not found: {body.selector}")
    return {"ok": True, "value": value.get("value")}


@app.post("/press")
async def press_key(body: PressModel):
    browser, cdp = await get_cdp()
    key = body.key.strip().lower()
    async with _lock:
        if key in ("enter", "return"):
            expr = """(() => {
              const el = document.activeElement;
              if (!el) return {found:false};
              el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true, cancelable:true}));
              el.dispatchEvent(new KeyboardEvent('keyup', {key:'Enter', code:'Enter', bubbles:true, cancelable:true}));
              const form = el.closest('form');
              if (form) form.dispatchEvent(new Event('submit', {bubbles:true, cancelable:true}));
              return {found:true};
            })()"""
        elif key in ("escape", "esc"):
            expr = """(() => {
              const el = document.activeElement;
              if (!el) return {found:false};
              el.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape', bubbles:true}));
              el.dispatchEvent(new KeyboardEvent('keyup', {key:'Escape', code:'Escape', bubbles:true}));
              return {found:true};
            })()"""
        elif key in ("tab",):
            expr = """(() => {
              const el = document.activeElement;
              if (!el) return {found:false};
              el.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', code:'Tab', bubbles:true, cancelable:true}));
              return {found:true};
            })()"""
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported key: {body.key}")
        await _evaluate(expr, cdp)
        await _wait_ready(cdp, timeout=8000)
    return {"ok": True}


@app.post("/scroll")
async def scroll_page(body: ScrollModel):
    _, cdp = await get_cdp()
    direction = body.direction.lower()
    if direction == "top":
        js = "window.scrollTo(0, 0)"
    elif direction == "bottom":
        js = "window.scrollTo(0, document.body.scrollHeight)"
    elif direction == "up":
        js = "window.scrollBy(0, -window.innerHeight * 0.8)"
    elif direction == "down":
        js = "window.scrollBy(0, window.innerHeight * 0.8)"
    else:
        raise HTTPException(status_code=400, detail=f"Invalid direction: {body.direction}")
    async with _lock:
        await _evaluate(f"(() => {{ {js}; return {{ok:true}}; }})()", cdp)
    return {"ok": True}


# ---------------------------------------------------------------------------
# LLM 驱动（browser-use Agent）
# ---------------------------------------------------------------------------


@app.post("/agent")
async def run_agent(body: AgentModel):
    from browser_use.agent.service import Agent
    from browser_use.llm.openai.chat import ChatOpenAI

    browser, _ = await get_cdp()
    llm_kwargs = {}
    if body.llm:
        llm_kwargs = {
            "model": body.llm.model,
            "api_key": body.llm.api_key,
            "base_url": body.llm.base_url,
        }
    else:
        llm_kwargs = {
            "model": os.environ.get("PI_BROWSER_USE_MODEL", "gpt-4o-mini"),
            "api_key": os.environ.get("PI_BROWSER_USE_API_KEY"),
            "base_url": os.environ.get("PI_BROWSER_USE_BASE_URL"),
        }
    llm = ChatOpenAI(**{k: v for k, v in llm_kwargs.items() if v})

    log.info("Running agent task: %s (llm=%s)", body.task[:80], llm_kwargs.get("model"))

    agent = Agent(
        task=body.task,
        llm=llm,
        browser_session=browser,
        max_failures=3,
        use_vision=body.use_vision,
        use_thinking=True,
        enable_planning=False,
        use_judge=False,
        generate_gif=False,
        max_actions_per_step=1,
        step_timeout=120,
    )
    try:
        history = await agent.run(max_steps=body.max_steps)
    except Exception as e:  # noqa: BLE001
        log.error("Agent run failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Agent run failed: {e}") from e

    # 汇总动作序列（model_output.action；model_output 可能为 None）
    actions = []
    for h in history.history:
        if h.model_output is None:
            continue
        for action in h.model_output.action:
            actions.append(action.model_dump(exclude_none=True))
    url = await browser.get_current_page_url()
    return {
        "ok": True,
        "final_url": url,
        "output": history.final_result() if hasattr(history, "final_result") else None,
        "is_done": history.is_done() if hasattr(history, "is_done") else None,
        "actions": actions[-50:],
    }


@app.post("/close")
async def close_browser():
    global _browser, _chrome_proc
    async with _lock:
        if _browser is not None:
            try:
                await _browser.stop()
            except Exception:  # noqa: BLE001
                pass
            _browser = None
        if _chrome_proc is not None:
            try:
                _chrome_proc.terminate()
            except Exception:  # noqa: BLE001
                pass
            _chrome_proc = None
    return {"ok": True}


# ---------------------------------------------------------------------------
# 实时镜像（SSE 推流）+ 输入注入（Codex/WebBuddy 式：右侧面板即真实浏览器）
# ---------------------------------------------------------------------------

class InputModel(BaseModel):
    type: str  # click | press | release | move | scroll | key | type
    x: float | None = None
    y: float | None = None
    key: str | None = None
    text: str | None = None
    delta_x: float | None = None
    delta_y: float | None = None
    button: str | None = None  # left | right | middle | back | forward
    buttons: int | None = None  # 位掩码：1=左 2=右 4=中（拖拽时 mouseMoved 携带）
    click_count: int | None = None  # 1=单击 2=双击（双击进入单元格编辑）


# CDP MouseButton → buttons 位掩码（mouseMoved 的 buttons 字段）
_BTN_MASK = {"left": 1, "right": 2, "middle": 4, "back": 8, "forward": 16}


_KEYMAP: dict[str, tuple[str, str, int, str | None]] = {
    "enter": ("Enter", "Enter", 13, "\r"),
    "escape": ("Escape", "Escape", 27, None),
    "tab": ("Tab", "Tab", 9, None),
    "backspace": ("Backspace", "Backspace", 8, None),
    "delete": ("Delete", "Delete", 46, None),
    "arrowup": ("ArrowUp", "ArrowUp", 38, None),
    "arrowdown": ("ArrowDown", "ArrowDown", 40, None),
    "arrowleft": ("ArrowLeft", "ArrowLeft", 37, None),
    "arrowright": ("ArrowRight", "ArrowRight", 39, None),
    "home": ("Home", "Home", 36, None),
    "end": ("End", "End", 35, None),
    "pageup": ("PageUp", "PageUp", 33, None),
    "pagedown": ("PageDown", "PageDown", 34, None),
    "f5": ("F5", "F5", 116, None),
}


@app.post("/input")
async def input_event(body: InputModel):
    """把面板上的鼠标/键盘事件注入真实浏览器（CDP Input 域，非 JS hack）。

    - click:   按下+抬起（可带 button 指定左/右键，click_count 指定单击/双击）
    - press:   只按下不释放（拖拽起点）
    - release: 只释放（拖拽终点）
    - move:    鼠标移动；带 buttons 位掩码时表示按住某键拖动（canvas 选区/拖拽）
    - scroll:  滚轮（delta_y 正=向下）
    - key:     特殊按键（Enter/Escape/Tab/方向键…）
    - type:    向当前聚焦元素插入文本（支持中文，Input.insertText）

    失败保护：CDP 调用统一 8s 短超时；弹窗/跨域导航导致 target detach 时快速失败并
    重新绑定 session 重试一次（避免镜像卡死 60s）。点击类操作会跟随新开的标签页
    （target=_blank 弹窗），让右侧镜像像真实浏览器一样跳转。
    """
    browser, cdp = await get_cdp()
    t = body.type.lower()
    button = (body.button or "left").lower()
    if button not in ("left", "right", "middle", "back", "forward", "none"):
        raise HTTPException(status_code=400, detail=f"Unsupported button: {body.button}")
    click_count = body.click_count or 1

    # 点击类操作前快照当前标签页集合，点击后用于跟随新开标签（target=_blank 弹窗）
    targets_before: set[str] | None = None
    if t in ("click", "press", "release"):
        try:
            targets_before = {p.target_id for p in browser.get_page_targets()}
        except Exception:  # noqa: BLE001
            targets_before = None

    dispatched = False
    for attempt in range(2):
        try:
            await _dispatch_input(cdp, body, button, click_count)
            dispatched = True
            break
        except TimeoutError:
            if attempt == 1:
                raise HTTPException(
                    status_code=504,
                    detail="Browser did not respond to input (target detached) — try again",
                ) from None
            log.warning("Input dispatch timed out — rebinding CDP session and retrying (%s)", t)
            _, cdp = await _page_cdp_once()
    if not dispatched:
        raise HTTPException(status_code=504, detail="Input dispatch failed")

    # 点击后跟随新开标签页：必应热点等 target=_blank 链接会新开标签，browser-use 出于
    # 自动化设计不会自动切换 agent focus，镜像会「点了没反应」。切过去就恢复正常跳转。
    if targets_before is not None:
        await _follow_popup(browser, targets_before)
    return {"ok": True}


async def _dispatch_input(cdp, body: InputModel, button: str, click_count: int) -> None:
    """在已绑定的 CDP session 上派发输入事件（每次 CDP 调用 8s 短超时）。"""
    t = body.type.lower()
    if t == "click":
        if body.x is None or body.y is None:
            raise HTTPException(status_code=400, detail="click needs x/y")
        for etype in ("mousePressed", "mouseReleased"):
            await _cdp_send(
                cdp, "Input.dispatchMouseEvent",
                {"type": etype, "x": body.x, "y": body.y, "button": button, "clickCount": click_count},
            )
    elif t == "press":
        if body.x is None or body.y is None:
            raise HTTPException(status_code=400, detail="press needs x/y")
        await _cdp_send(
            cdp, "Input.dispatchMouseEvent",
            {
                "type": "mousePressed", "x": body.x, "y": body.y,
                "button": button, "buttons": _BTN_MASK.get(button, 0), "clickCount": click_count,
            },
        )
    elif t == "release":
        if body.x is None or body.y is None:
            raise HTTPException(status_code=400, detail="release needs x/y")
        await _cdp_send(
            cdp, "Input.dispatchMouseEvent",
            {"type": "mouseReleased", "x": body.x, "y": body.y, "button": button, "buttons": 0, "clickCount": click_count},
        )
    elif t == "move":
        if body.x is None or body.y is None:
            raise HTTPException(status_code=400, detail="move needs x/y")
        params = {"type": "mouseMoved", "x": body.x, "y": body.y}
        # 拖拽：鼠标正按着某键，告诉浏览器当前按住状态（canvas 选区/拖拽依赖它）
        if body.buttons:
            params["buttons"] = body.buttons
            params["button"] = "left" if body.buttons & 1 else ("right" if body.buttons & 2 else "none")
        await _cdp_send(cdp, "Input.dispatchMouseEvent", params)
    elif t == "scroll":
        await _cdp_send(
            cdp, "Input.dispatchMouseEvent",
            {"type": "mouseWheel", "x": body.x or 0, "y": body.y or 0, "deltaX": body.delta_x or 0, "deltaY": body.delta_y or 0},
        )
    elif t == "key":
        key = (body.key or "").lower()
        if key not in _KEYMAP:
            raise HTTPException(status_code=400, detail=f"Unsupported key: {body.key}")
        key_name, code, vk, text = _KEYMAP[key]
        params = {"type": "keyDown", "key": key_name, "code": code, "windowsVirtualKeyCode": vk}
        if text:
            params["text"] = text
        await _cdp_send(cdp, "Input.dispatchKeyEvent", params)
        await _cdp_send(
            cdp, "Input.dispatchKeyEvent",
            {"type": "keyUp", "key": key_name, "code": code, "windowsVirtualKeyCode": vk},
        )
    elif t == "type":
        if not body.text:
            raise HTTPException(status_code=400, detail="type needs text")
        await _cdp_send(cdp, "Input.insertText", {"text": body.text})
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported input type: {body.type}")


async def _follow_popup(browser, targets_before: set[str]) -> None:
    """点击后把 agent focus 切到新开标签页（target=_blank 弹窗）。

    必应热点等链接用 target=_blank，真实浏览器会新开标签页；browser-use 不会自动切换
    agent focus（其设计是自动化场景下后台开标签），导致镜像停留在原页面、用户觉得
    「点了没反应」。这里等弹窗创建后把焦点切过去，镜像跟随跳转。
    """
    try:
        await asyncio.sleep(0.5)  # 等弹窗创建/导航稳定
        page_targets = browser.get_page_targets()
        new_ids = [t.target_id for t in page_targets if t.target_id not in targets_before]
        if not new_ids:
            return
        tid = new_ids[-1]  # 列表顺序≈attach 顺序，取最后出现的新标签
        log.info("Click opened new tab %s — switching mirror focus to it", tid[-6:])
        await asyncio.wait_for(
            browser.get_or_create_cdp_session(target_id=tid, focus=True), timeout=8
        )
    except Exception as e:  # noqa: BLE001
        log.warning("Follow popup failed: %s", e)


class EvaluateModel(BaseModel):
    expression: str


class DownloadSetupModel(BaseModel):
    path: str | None = None  # 留空用默认 sidecar/downloads/


# 下载目录（导出 xlsx 等文件保存到这里）；None 表示未配置
_download_dir: str | None = None


@app.post("/downloads/setup")
async def setup_downloads(body: DownloadSetupModel):
    """设置 CDP 下载行为：把页面触发下载的文件保存到指定目录（默认 sidecar/downloads/）。

    默认 headless Chrome 会把下载丢弃（不弹保存框），导出 Excel/CSV 前先调这个接口。
    """
    global _download_dir
    _download_dir = (body.path or "").strip() or str(Path(__file__).resolve().parent / "downloads")
    Path(_download_dir).mkdir(parents=True, exist_ok=True)
    browser, cdp = await get_cdp()
    async with _lock:
        # 同时设 browser 级 + page 级下载行为（headless 下个别页面只认 page 级）
        for method, sid in (("Browser.setDownloadBehavior", None), ("Page.setDownloadBehavior", cdp.session_id)):
            try:
                await asyncio.wait_for(
                    cdp.cdp_client.send_raw(
                        method=method,
                        params={"behavior": "allow", "downloadPath": _download_dir, "eventsEnabled": True},
                        session_id=sid,
                    ),
                    timeout=8,
                )
            except Exception as e:  # noqa: BLE001
                log.warning("%s failed: %s", method, e)
    return {"ok": True, "path": _download_dir}


@app.get("/downloads/path")
async def downloads_path():
    return {"ok": True, "path": _download_dir or None}


@app.post("/evaluate")
async def evaluate(body: EvaluateModel):
    """在页面里执行 JS 表达式（returnByValue），供 agent 调试/读取页面状态。"""
    _, cdp = await get_cdp()
    async with _lock:
        result = await _evaluate(body.expression, cdp)
    try:
        value = result.get("result", {}).get("value")
    except Exception:  # noqa: BLE001
        value = None
    return {"value": value, "raw": result}


@app.get("/screencast")
async def screencast(w: int = 0, h: int = 0, dpr: float = 1.0):
    """SSE：持续推送真实浏览器的 JPEG 帧（右侧面板上的实时镜像）。

    ?w=&h=&dpr= —— 前端把面板实际尺寸（CSS px × 用户屏幕 DPR）传进来：
    侧车用 Emulation.setDeviceMetricsOverride 把浏览器 viewport 设成与面板一致，
    截图像素 = w*dpr × h*dpr，面板 1:1 显示 → 不拉伸、不变形、像素级清晰。
    帧率 ~10fps（配合小尺寸截图），点击反馈基本实时。

    浏览器会话死亡时帧循环自动报错退避，下一帧经 get_browser() 自愈重启，
    连接不中断（客户端无需重连）。
    """
    # 防御性钳制（面板尺寸异常时不至于把浏览器撑爆）
    view_w = min(max(int(w), 200), 2500)
    view_h = min(max(int(h), 200), 2500)
    view_dpr = min(max(float(dpr or 1), 1.0), 3.0)

    async def event_stream():
        last_error: str | None = None
        applied_key: tuple | None = None
        while True:
            try:
                browser = await get_browser()  # 内部短锁探活/自愈
                async with _lock:  # 帧捕获锁（快速；agent 长任务会短暂停帧）
                    page = await asyncio.wait_for(browser.get_current_page(), timeout=8)
                    if page is None:
                        await asyncio.wait_for(browser.new_page(), timeout=8)
                        page = await asyncio.wait_for(browser.get_current_page(), timeout=8)
                    cdp = await asyncio.wait_for(
                        browser.get_or_create_cdp_session(target_id=page._target_id, focus=False), timeout=8
                    )
                    target_id = str(getattr(page, "_target_id", ""))
                    # 把 viewport 设成面板尺寸（CSS px），deviceScaleFactor=dpr → 截图像素级清晰。
                    # 目标页换了或尺寸/DPR 变了就重新套用（新页面不会继承 override；
                    # 面板缩放后也必须跟上，否则帧与面板长宽比不匹配会被拉伸）。
                    key = (target_id, view_w, view_h, view_dpr)
                    if w > 0 and h > 0 and applied_key != key:
                        await asyncio.wait_for(
                            cdp.cdp_client.send_raw(
                                method="Emulation.setDeviceMetricsOverride",
                                params={
                                    "width": view_w,
                                    "height": view_h,
                                    "deviceScaleFactor": view_dpr,
                                    "mobile": False,
                                },
                                session_id=cdp.session_id,
                            ),
                            timeout=8,
                        )
                        applied_key = key
                    result = await asyncio.wait_for(
                        cdp.cdp_client.send_raw(
                            method="Page.captureScreenshot",
                            params={"format": "jpeg", "quality": 75, "captureBeyondViewport": False},
                            session_id=cdp.session_id,
                        ),
                        timeout=8,
                    )
                data = (result or {}).get("data", "") if isinstance(result, dict) else ""
                if data:
                    yield f"data: {data}\n\n"
                    last_error = None
                await asyncio.sleep(0.07)
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                if msg != last_error:
                    last_error = msg
                    # 只记日志，不要往 SSE 里推 error 事件：前端会把任意 data: 载荷当
                    # 截图帧，JSON 错误信息拼成非法 data URL 后图片裂开 → 白屏 + alt 文字。
                    # 帧循环继续重试，浏览器自愈后画面自动恢复。
                    log.warning("screencast frame error: %s", msg)
                await asyncio.sleep(1.0)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PI_BROWSER_USE_PORT", "17865"))
    log.info("browser-use sidecar listening on 127.0.0.1:%s", port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
