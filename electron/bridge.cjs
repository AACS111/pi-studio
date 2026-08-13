"use strict";

/**
 * 原生浏览器控制桥（Electron 主进程内嵌 WebContentsView）— Semantic Browser V2。
 *
 * 提供 Electron 原生模式专用的 HTTP 语义接口（127.0.0.1，随机端口），
 * 让 Next 服务 / agent 用同一套 /api/browser/control/* 语义控制右侧
 * 原生浏览器。页面由 Electron 直接合成，控制命令通过
 * webContents.executeJavaScript / CDP 落到同一个页面。
 *
 * 右侧浏览器仅在 Electron 桌面模式（dev:electron / 打包应用）可用；
 * npm run dev 纯浏览器模式不启动本桥，控制接口返回 502。
 *
 * 相比 V1 的新增能力（Agent-facing 语义层）：
 *   GET  /snapshot              → 高价值交互元素快照（ref/role/name/value/state）
 *   POST /execute               → 一次 HTTP + 一次 JS 上下文批量执行多个动作
 *   POST /select /fill /check   → 语义动作（原生 select / Ant Design / Element Plus）
 *   POST /wait /assert          → 条件等待与断言
 *   POST /open                  → 支持 wait:"dom"|"finish"|readyWhen + 返回内嵌 snapshot
 *   POST /click /type /press    → 升级为评分定位器（exact>aria>placeholder>testid>contains）
 *
 * 设计原则：
 *   1. Agent 先 observe（/snapshot 拿到 ref），再 act（/execute 按 ref 批量执行），
 *      不要“一步一 curl”。快照 ref 只在快照有效期（DOM 签名一致）内有效。
 *   2. 普通操作（click/type/select/scroll）不等待页面 load；只有检测到导航
 *      （/open、/back、/forward、/reload）才等待。
 *   3. 定位器是评分制：精确文本/aria/placeholder/testid 优先，contains 兜底，
 *      歧义（两个同分候选）返回 409 + 候选列表让 agent 改用 ref。
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOAD_TIMEOUT_MS = 15000;
const DEFAULT_CONDITION_TIMEOUT_MS = 10000;
// 语义动作（click/fill/select/check/press）执行前的 auto-wait 超时：
// 等待元素可交互且几何稳定（Playwright actionability 的轻量版）。
const DEFAULT_ACTIONABLE_WAIT_MS = 4000;
const SNAPSHOT_MAX = 300;
const SNAPSHOT_REGISTRY_CAP = 80;

// ---------------------------------------------------------------------------
// 页面引擎（注入到 WebContents 执行的一段纯 JS）
// ---------------------------------------------------------------------------

/**
 * 生成页面引擎字符串。执行后返回一个对象：
 *   { $collect, $signature, $findBest, $resolve, $doSelect, $setValue,
 *     $waitFor, $assert, $sleep, $elName, $isVisible, $topCandidates }
 * 注意：页面 JS 内不要使用反引号 / ${ }，以免与外层模板字符串冲突。
 */
function pageEngine(maxElements) {
  return `(() => {
  const $MAX = ${maxElements};
  const $selectors = [
    'button','input','textarea','select','a','label',
    '[role="button"]','[role="link"]','[role="checkbox"]','[role="radio"]',
    '[role="combobox"]','[role="listbox"]','[role="option"]','[role="tab"]',
    '[role="textbox"]','[role="searchbox"]','[role="spinbutton"]','[role="slider"]',
    '[role="menuitem"]','[contenteditable="true"]','[onclick]'
  ];
  const $sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const $isVisible = function (el) {
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const op = s.opacity;
      if (op !== '' && Number(op) === 0) return false; // 透明（动画前/渐隐）不可交互
      return true;
    } catch (e) { return false; }
  };
  // auto-wait 辅助：元素是否可交互（可见 + 未禁用 + 可接收指针事件）
  const $isActionable = function (el) {
    if (!el || !$isVisible(el)) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    try {
      const pe = getComputedStyle(el).pointerEvents;
      if (pe === 'none') return false;
    } catch (e) {}
    return true;
  };
  // auto-wait 辅助：元素是否几何稳定（两次布局一致 —— 动画/懒加载中的元素会移动）
  const $isStable = async function (el) {
    try {
      const r1 = el.getBoundingClientRect();
      await $sleep(60);
      const r2 = el.getBoundingClientRect();
      const drift = Math.abs(r1.x - r2.x) + Math.abs(r1.y - r2.y);
      const sizeDelta = Math.abs(r1.width - r2.width) + Math.abs(r1.height - r2.height);
      return drift <= 0.5 && sizeDelta <= 0.5;
    } catch (e) { return false; }
  };
  // auto-wait 核心：轮询等待元素可交互且稳定（Playwright actionability 的轻量版）。
  // 超时后返回最后一次状态（乐观返回，由调用方决定是否继续），避免死等。
  const $waitActionable = async function (el, timeoutMs) {
    const deadline = Date.now() + (timeoutMs > 0 ? timeoutMs : ${DEFAULT_ACTIONABLE_WAIT_MS});
    let ready = false;
    while (Date.now() < deadline) {
      if ($isActionable(el) && await $isStable(el)) { ready = true; break; }
      await $sleep(80);
    }
    if (!ready) ready = $isActionable(el);
    return ready;
  };
  const $inferRole = function (el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = String(el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'a') return 'link';
    if (tag === 'label') return 'label';
    return tag;
  };
  const $scanSiblings = function (node) {
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.matches && sib.matches('button,a,input,select,textarea,label,[role]')) { sib = sib.previousElementSibling; continue; }
      const t = (sib.innerText || sib.textContent || '').trim();
      if (t && t.length <= 30 && !sib.querySelector('input,select,textarea,button,[role]')) return t.replace(/[:：]\\s*$/, '');
      sib = sib.previousElementSibling;
    }
    return '';
  };
  const $nearbyLabel = function (el) {
    try {
      // 邻近标签只对表单控件有意义；按钮/链接等自带文本，不需要也不应该去猜
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT' && el.getAttribute('role') !== 'combobox') return '';
      // 1) 直接兄弟（span/div/label）
      let t = $scanSiblings(el);
      if (t) return t;
      // 2) 组件根（.ant-select / .el-select / form-item）的前一个兄弟通常是标签
      const root = el.closest('.ant-select, .el-select, .el-form-item, .ant-form-item, [class*="form-item"]');
      if (root) {
        t = $scanSiblings(root);
        if (t) return t;
      }
      // 3) 容器内 label（el-form-item__label / ant-form-item-label）
      const wrap = el.closest('.el-form-item, .ant-form-item, [class*="form-item"], [class*="field"], [class*="filter"], [class*="search"]');
      if (wrap) {
        const lbl = wrap.querySelector('.el-form-item__label, .ant-form-item-label, label, [class*="label"]');
        if (lbl) {
          const lt = (lbl.innerText || '').trim().replace(/[:：]\\s*$/, '');
          if (lt) return lt;
        }
      }
    } catch (e) {}
    return '';
  };
  const $labelText = function (el) {
    try {
      if (el.labels && el.labels.length) {
        const t = (el.labels[0].innerText || '').trim();
        if (t) return t;
      }
      if (el.id) {
        const lbl = document.querySelector('label[for="' + el.id.replace(/"/g, '&quot;') + '"]');
        if (lbl) { const t = (lbl.innerText || '').trim(); if (t) return t; }
      }
    } catch (e) {}
    return $nearbyLabel(el);
  };
  const $elName = function (el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    // 图标按钮：无文本但带 title（antd/el 的图标按钮通常有 title）
    const titleAttr = el.getAttribute('title');
    if (titleAttr && titleAttr.trim()) return titleAttr.trim();
    // svg 内部的 <title> 标签（纯图标按钮的语义名）
    try {
      const svgTitle = el.querySelector('svg title, svg > title');
      if (svgTitle && svgTitle.textContent && svgTitle.textContent.trim()) return svgTitle.textContent.trim();
    } catch (e) {}
    const text = (el.innerText || el.textContent || '').trim();
    if (text && text.length > 0 && text.length <= 120) return text;
    const ph = el.getAttribute('placeholder');
    if (ph && ph.trim()) return ph.trim();
    const nearby = $nearbyLabel(el);
    if (nearby) return nearby;
    if ('value' in el && el.value != null && String(el.value) !== '') return String(el.value).slice(0, 120);
    return '';
  };
  const $collect = function (includeEl) {
    const seen = new Set();
    const out = [];
    const nodes = document.querySelectorAll($selectors.join(','));
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (seen.has(el)) continue;
      seen.add(el);
      if (!$isVisible(el)) continue;
      const role = el.getAttribute('role') || $inferRole(el);
      let name;
      let value;
      if (el.tagName === 'SELECT') {
        // select：name 用关联 label，value 用选中项文本（不要把所有 option 拼起来）
        name = $labelText(el);
        const selOpt = el.selectedOptions && el.selectedOptions[0];
        value = selOpt ? selOpt.text.trim() : '';
      } else {
        name = $elName(el);
        value = ('value' in el && el.value != null) ? String(el.value) : (el.getAttribute('value') || '');
      }
      const item = {
        ref: 'e' + out.length,
        tag: el.tagName.toLowerCase(),
        role: role,
        name: (name || '').slice(0, 120),
        value: (value || '').slice(0, 200),
        placeholder: el.getAttribute('placeholder') || '',
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        checked: !!el.checked || el.getAttribute('aria-checked') === 'true',
        label: $labelText(el)
      };
      if (includeEl) item.el = el; // 仅 execute 使用：附带真实 DOM 节点
      out.push(item);
      if (out.length >= $MAX) break;
    }
    return out;
  };
  const $collectLive = function () { return $collect(true); };
  const $signature = function (elements) {
    let s = elements.length + ':';
    const upto = Math.min(elements.length, 60);
    for (let i = 0; i < upto; i++) {
      s += elements[i].tag + '/' + elements[i].role + '/' + elements[i].name + '|';
    }
    return s;
  };
  const $score = function (el, target) {
    if (!target) return 0;
    let score = 0;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || $inferRole(el);
    const text = (el.innerText || el.textContent || '').trim();
    const aria = el.getAttribute('aria-label') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const nameAttr = el.getAttribute('name') || '';
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || '';
    const elId = el.id || '';
    if (target.role) {
      if (role === target.role) score += 100;
      else if (tag === target.role) score += 80;
    }
    if (target.name) {
      const needle = String(target.name).trim();
      if (needle) {
        if (testId === needle) score += 200;
        if (aria === needle) score += 150;
        const titleAttr = el.getAttribute('title') || ''; // 图标按钮的 title
        if (titleAttr === needle) score += 130;
        if (placeholder === needle) score += 120;
        if (nameAttr === needle) score += 100;
        if (elId === needle) score += 100;
        if (text === needle) score += 100;
        if (text.indexOf(needle) !== -1) score += 30;
        const lt = $labelText(el);
        if (lt && lt === needle) score += 120;
        else if (lt && lt.indexOf(needle) !== -1) score += 30;
      }
    }
    if (target.css) {
      try { if (el.matches(target.css)) score += 200; } catch (e) {}
    }
    if (target.value !== undefined && target.value !== null && 'value' in el) {
      if (String(el.value) === String(target.value)) score += 40;
    }
    if ($isVisible(el)) score += 50;
    if (!el.disabled && el.getAttribute('aria-disabled') !== 'true') score += 30;
    return score;
  };
  const $findBest = function (target) {
    if (!target) return { el: null, score: 0, gap: 0 };
    let best = null; let bestScore = 0; let second = 0;
    const nodes = document.querySelectorAll($selectors.join(','));
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!$isVisible(el)) continue;
      const s = $score(el, target);
      if (s > bestScore) { second = bestScore; bestScore = s; best = el; }
      else if (s > second) second = s;
    }
    return { el: best, score: bestScore, gap: bestScore - second };
  };
  const $controlOf = function (el) {
    if (!el || el.tagName !== 'LABEL') return el;
    const forId = el.getAttribute('for');
    if (forId) { const c = document.getElementById(forId); if (c) return c; }
    const inner = el.querySelector('input,select,textarea,button');
    return inner || el;
  };
  const $setValue = function (el, value) {
    const str = String(value == null ? '' : value);
    if (el.isContentEditable) {
      el.textContent = str;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    let proto = null;
    if (el.tagName === 'TEXTAREA') proto = HTMLTextAreaElement.prototype;
    else if (el.tagName === 'INPUT') proto = HTMLInputElement.prototype;
    if (proto && Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set) {
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, str);
    } else {
      el.value = str;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const $doSelect = async function (el, value) {
    const needle = String(value == null ? '' : value);
    if (el.tagName === 'SELECT') {
      let opt = null;
      for (let i = 0; i < el.options.length; i++) {
        const o = el.options[i];
        if (o.text.trim() === needle || o.value === needle) { opt = o; break; }
      }
      if (!opt) throw new Error('OPTION_NOT_FOUND:' + needle);
      $setValue(el, opt.value);
      return { method: 'native', value: opt.text.trim().slice(0, 80) };
    }
    const role = el.getAttribute('role') || '';
    const isCombobox = role === 'combobox' ||
      (el.tagName === 'INPUT' && (el.getAttribute('aria-haspopup') === 'listbox' ||
        !!el.closest('.ant-select, .el-select, [class*="-select"], [class*="Select"]')));
    if (isCombobox) {
      const optSels = '[role="option"], .ant-select-item-option, .ant-select-dropdown-menu-item, .el-select-dropdown__item, .el-select-dropdown li, .ivu-select-item, [class*="select-dropdown"] *, [class*="dropdown"] [class*="item"], [class*="option"], [class*="Option"]';
      const findOption = function () {
        let best = null; let bestScore = 0;
        const opts = document.querySelectorAll(optSels);
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          if (!$isVisible(opt)) continue;
          const t = (opt.innerText || opt.textContent || '').trim();
          const aria = opt.getAttribute('aria-label') || '';
          const title = opt.getAttribute('title') || '';
          let s = 0;
          if (t === needle || aria === needle || title === needle) s = 200;
          else if (t.indexOf(needle) !== -1) s = 80;
          // 框架专属 option class 加分：antd/Element Plus 虚拟列表会渲染无 class 的
          // [role=option] 幽灵元素（同分时排前面会抢到点击），真实选项必须优先
          if (opt.className && /ant-select-item-option|el-select-dropdown__item|el-select-dropdown li|ivu-select-item|ant-select-dropdown-menu-item/.test(String(opt.className))) s += 50;
          if (s > bestScore) { bestScore = s; best = opt; }
        }
        return bestScore >= 80 ? best : null;
      };
      // 打开下拉的策略梯子：inner click → 外层 wrapper mousedown/mouseup/click → ArrowDown 键盘
      const openLadder = [
        function () { el.click(); },
        function () {
          el.focus();
          const wrap = el.closest('[class*="select"], [class*="Select"], .el-form-item, .ant-form-item, [class*="field"], [class*="filter"]') || el.parentElement;
          if (wrap && wrap !== el) {
            ['mousedown', 'mouseup', 'click'].forEach(function (t) {
              wrap.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
            });
          }
        },
        function () {
          el.focus();
          ['ArrowDown', 'Enter'].forEach(function (k) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: k, code: k, bubbles: true, cancelable: true }));
          });
        }
      ];
      for (let i = 0; i < openLadder.length; i++) {
        try { openLadder[i](); } catch (e) {}
        await $sleep(200);
        const opt = findOption();
        if (opt) {
          try { opt.scrollIntoView({ block: 'center' }); } catch (e) {}
          opt.click();
          await $sleep(80);
          return { method: 'dropdown', value: (opt.innerText || opt.textContent || '').trim().slice(0, 80) };
        }
      }
      if (el.tagName === 'INPUT') {
        $setValue(el, needle);
        return { method: 'input-fallback', value: needle.slice(0, 80) };
      }
      throw new Error('OPTION_NOT_FOUND:' + needle);
    }
    if (el.tagName === 'INPUT') {
      $setValue(el, needle);
      return { method: 'input', value: needle.slice(0, 80) };
    }
    throw new Error('NOT_SELECTABLE');
  };
  const $waitFor = async function (action) {
    const cond = action.for || action.condition || {};
    const timeout = Number(action.timeout || ${DEFAULT_CONDITION_TIMEOUT_MS});
    const deadline = Date.now() + timeout;
    const check = function () {
      if (cond.selector) {
        try { return !!document.querySelector(cond.selector); } catch (e) { return false; }
      }
      if (cond.text) {
        const bodyText = (document.body ? (document.body.innerText || document.body.textContent || '') : '');
        return bodyText.indexOf(String(cond.text)) !== -1;
      }
      if (cond.url) {
        const u = String(cond.url);
        return location.href.indexOf(u) !== -1 || location.href.startsWith(u);
      }
      if (cond.role || cond.name) {
        const t = {}; if (cond.role) t.role = cond.role; if (cond.name) t.name = cond.name;
        const r = $findBest(t);
        return !!(r.el && r.score >= 100);
      }
      return false;
    };
    while (Date.now() < deadline) {
      if (check()) return true;
      await $sleep(150);
    }
    return false;
  };
  const $assert = function (action) {
    if (action.text !== undefined) {
      const bodyText = (document.body ? (document.body.innerText || document.body.textContent || '') : '');
      return { ok: bodyText.indexOf(String(action.text)) !== -1, found: true, detail: 'text' };
    }
    const target = action.target;
    if (!target) return { ok: false, found: false, detail: 'no target' };
    const r = $findBest(target);
    if (!r.el) return { ok: false, found: false, detail: 'ELEMENT_NOT_FOUND' };
    const state = action.state || 'exists';
    let ok = true;
    if (state === 'visible') ok = $isVisible(r.el);
    else if (state === 'enabled') ok = !r.el.disabled && r.el.getAttribute('aria-disabled') !== 'true';
    else if (state === 'disabled') ok = !!r.el.disabled || r.el.getAttribute('aria-disabled') === 'true';
    else if (state === 'checked') ok = !!r.el.checked || r.el.getAttribute('aria-checked') === 'true';
    else if (state === 'unchecked') ok = !r.el.checked && r.el.getAttribute('aria-checked') !== 'true';
    else if (state === 'selected') ok = r.el.getAttribute('aria-selected') === 'true' || !!r.el.closest('.ant-select-item-option-selected, .el-select-dropdown__item.selected, [class*="selected"], [class*="Selected"]');
    else if (state === 'value') ok = 'value' in r.el && String(r.el.value) === String(action.value != null ? action.value : '');
    return { ok: ok, found: true, detail: state };
  };
  const $topCandidates = function (target) {
    const out = [];
    const nodes = document.querySelectorAll($selectors.join(','));
    const scored = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!$isVisible(el)) continue;
      const s = $score(el, target);
      // 过滤纯基础分（可见+可用=80）的无关元素：>80 说明有实质匹配
      if (s > 80) scored.push({ score: s, tag: el.tagName.toLowerCase(), name: $elName(el) });
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    for (let i = 0; i < Math.min(scored.length, 6); i++) out.push(scored[i]);
    return out;
  };
  const $resolve = function (action, elements, refsMap) {
    if (action.ref) {
      const m = /^e(\\d+)$/.exec(String(action.ref));
      if (!m) return { err: 'REF_STALE:' + action.ref };
      const idx = Number(m[1]);
      const item = elements[idx];
      const expect = refsMap && refsMap[idx];
      if (item && item.el && expect) {
        const nameMatch = (item.name || '') === (expect.name || '');
        if (item.tag === expect.tag && nameMatch) return { el: $controlOf(item.el) };
        let seen = 0;
        for (let i = 0; i < elements.length; i++) {
          const c = elements[i];
          if (!c.el || c.tag !== expect.tag) continue;
          if (seen === expect.ord) {
            if ((c.name || '') === (expect.name || '')) return { el: $controlOf(c.el) };
            return { err: 'REF_STALE:' + action.ref };
          }
          seen++;
        }
        return { err: 'REF_STALE:' + action.ref };
      }
      if (item && item.el) return { el: $controlOf(item.el) };
      return { err: 'REF_STALE:' + action.ref };
    }
    if (action.target) {
      let target = action.target;
      if (typeof target === 'string') target = { name: target };
      const r = $findBest(target);
      if (!r.el || r.score < 100) return { err: 'ELEMENT_NOT_FOUND' };
      if (r.gap < 40) return { err: 'AMBIGUOUS', candidates: $topCandidates(target) };
      return { el: $controlOf(r.el) };
    }
    return { err: 'NO_TARGET' };
  };
  return {
    $collect: $collect, $collectLive: $collectLive, $signature: $signature, $findBest: $findBest, $resolve: $resolve,
    $doSelect: $doSelect, $setValue: $setValue, $waitFor: $waitFor, $assert: $assert,
    $sleep: $sleep, $elName: $elName, $isVisible: $isVisible, $topCandidates: $topCandidates,
    $isActionable: $isActionable, $isStable: $isStable, $waitActionable: $waitActionable
  };
})()`;
}

function snapshotScript(max) {
  return `(() => {
    const E = ${pageEngine(max)};
    const elements = E.$collect();
    return { url: location.href, title: document.title, signature: E.$signature(elements), elements: elements };
  })()`;
}

function executeScript(actions, snapshotId, snapshotMeta, maxElements) {
  const refsMap = snapshotMeta && Array.isArray(snapshotMeta.refs) ? snapshotMeta.refs : null;
  const registrySignature = snapshotMeta && snapshotMeta.signature ? snapshotMeta.signature : "";
  return `(() => {
    const E = ${pageEngine(maxElements || SNAPSHOT_MAX)};
    const elements = E.$collectLive();
    const signature = E.$signature(elements);
    const refsMap = ${JSON.stringify(refsMap)};
    const actions = ${JSON.stringify(actions)};
    const results = [];
    const run = async function () {
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        const entry = { ok: false, action: action.type, ref: action.ref || null };
        try {
          if (action.type === 'wait') {
            entry.ok = await E.$waitFor(action);
            entry.value = entry.ok ? 'satisfied' : 'timeout';
            results.push(entry);
            continue;
          }
          if (action.type === 'assert' || action.type === 'assertText') {
            const r = E.$assert(action);
            entry.ok = r.ok; entry.found = r.found; entry.detail = r.detail;
            results.push(entry);
            continue;
          }
          if (action.type === 'scroll') {
            if (action.target || action.ref) {
              const resolved = E.$resolve(action, elements, refsMap);
              if (resolved.err) { entry.error = resolved.err; results.push(entry); if (action.stopOnError !== false) break; continue; }
              try { resolved.el.scrollIntoView({ block: 'center' }); } catch (e) {}
            } else {
              const dir = String(action.value || action.direction || 'down');
              if (dir === 'top') window.scrollTo(0, 0);
              else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
              else if (dir === 'up') window.scrollBy(0, -window.innerHeight * 0.8);
              else window.scrollBy(0, window.innerHeight * 0.8);
            }
            entry.ok = true;
            results.push(entry);
            continue;
          }
          if (action.type === 'focus') {
            const resolved = E.$resolve(action, elements, refsMap);
            if (resolved.err) { entry.error = resolved.err; results.push(entry); if (action.stopOnError !== false) break; continue; }
            resolved.el.focus();
            entry.ok = true;
            results.push(entry);
            continue;
          }
          const resolved = E.$resolve(action, elements, refsMap);
          if (resolved.err) {
            entry.error = resolved.err;
            if (resolved.candidates) entry.candidates = resolved.candidates;
            results.push(entry);
            if (action.stopOnError !== false) break;
            continue;
          }
          const el = resolved.el;
          // ---- auto-wait（Playwright actionability 的轻量版）----
          // 确定性交互动作前，等待元素可交互（可见+未禁用+可接收指针）且几何稳定
          // （动画/懒加载中的元素会移动）。超时后乐观继续（由调用方看结果决定重试）。
          if (action.type === 'click' || action.type === 'fill' || action.type === 'select'
              || action.type === 'check' || action.type === 'press' || action.type === 'focus') {
            const waitMs = Number(action.wait != null ? action.wait : ${DEFAULT_ACTIONABLE_WAIT_MS});
            const ready = await E.$waitActionable(el, waitMs);
            entry.waited = ready;
            if (!ready) {
              entry.error = 'NOT_ACTIONABLE:元素未就绪（不可见/未稳定/被禁用/指针不可达）';
              results.push(entry);
              if (action.stopOnError !== false) break;
              continue;
            }
          }
          if (action.type === 'click') {
            try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
            el.click();
            entry.ok = true;
            entry.tag = el.tagName.toLowerCase();
            entry.name = E.$elName(el).slice(0, 80);
          } else if (action.type === 'fill') {
            el.focus();
            const val = action.value != null ? String(action.value) : '';
            const cur = ('value' in el && el.value != null) ? String(el.value) : '';
            E.$setValue(el, action.append ? cur + val : val);
            entry.ok = true;
            entry.value = ('value' in el ? String(el.value) : '').slice(0, 80);
          } else if (action.type === 'select') {
            const r = await E.$doSelect(el, action.value);
            entry.ok = true; entry.method = r.method; entry.value = r.value;
          } else if (action.type === 'check') {
            const want = action.value === true || action.value === 'true' || action.value === 'check' || action.value === 'on';
            const now = !!el.checked || el.getAttribute('aria-checked') === 'true';
            if (now !== want) el.click();
            entry.ok = true; entry.checked = want;
          } else if (action.type === 'press') {
            el.focus();
            const key = String(action.key || action.value || 'Enter');
            el.dispatchEvent(new KeyboardEvent('keydown', { key: key, code: key, bubbles: true, cancelable: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: key, code: key, bubbles: true, cancelable: true }));
            entry.ok = true; entry.key = key;
          } else {
            entry.error = 'UNSUPPORTED_ACTION:' + action.type;
            results.push(entry);
            if (action.stopOnError !== false) break;
            continue;
          }
          results.push(entry);
        } catch (e) {
          entry.error = String((e && e.message) || e);
          results.push(entry);
          if (action.stopOnError !== false) break;
        }
      }
      const allOk = results.length > 0 && results.every(function (r) { return r.ok; });
      return {
        ok: allOk,
        completed: results.length,
        failed: results.filter(function (r) { return !r.ok; }).length,
        results: results,
        snapshotInvalidated: signature !== ${JSON.stringify(registrySignature)},
        snapshotId: ${JSON.stringify(snapshotId || null)},
        url: location.href,
        title: document.title
      };
    };
    return run();
  })()`;
}

// ---------------------------------------------------------------------------
// 快照注册表：snapshotId → { signature, max, refs, url, takenAt }
// ref 只保存「第 N 个同 tag 元素」的序号，不保存 DOM 引用（DOM 会变）。
// ---------------------------------------------------------------------------
const snapshotRegistry = new Map();

async function takeSnapshot(wc, max) {
  const result = await evaluate(wc, snapshotScript(max));
  const elements = Array.isArray(result.elements) ? result.elements : [];
  const refs = [];
  const tagCounts = {};
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    const ord = tagCounts[e.tag] || 0;
    tagCounts[e.tag] = ord + 1;
    refs.push({ ref: e.ref, tag: e.tag, ord: ord, name: e.name || "" });
  }
  const snapshotId = "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  snapshotRegistry.set(snapshotId, {
    signature: result.signature || "",
    max: max,
    refs: refs,
    url: result.url || "",
    takenAt: Date.now(),
  });
  while (snapshotRegistry.size > SNAPSHOT_REGISTRY_CAP) {
    snapshotRegistry.delete(snapshotRegistry.keys().next().value);
  }
  return {
    snapshotId,
    url: result.url || null,
    title: result.title || null,
    signature: result.signature || "",
    elements,
    count: elements.length,
  };
}

function evaluate(wc, expression) {
  return wc.executeJavaScript(expression, true);
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

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
  const body = { error: err && err.message ? err.message : String(err) };
  if (err && err.candidates) body.candidates = err.candidates;
  sendJson(res, status, body);
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

/**
 * 通用导航等待：优先 load 事件；SPA hash 路由（base 相同）不触发 load 事件，
 * 用「URL 变化 + readyState 就绪」轮询兜底。
 */
function waitForNav(wc, trigger, { timeoutMs = LOAD_TIMEOUT_MS, beforeUrl = null } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", onFinish);
      wc.removeListener("did-fail-load", onFail);
      stopped = true;
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => {
      const err = new Error("Page load timed out");
      err.status = 504;
      finish(err);
    }, timeoutMs);
    const onFinish = () => finish(null);
    const onFail = (_e, code, description, _u, isMainFrame) => {
      if (!isMainFrame || settled) return;
      const err = new Error(`Page load failed: ${description} (${code})`);
      err.status = 504;
      finish(err);
    };
    wc.once("did-finish-load", onFinish);
    wc.once("did-fail-load", onFail);
    const beforeBase = beforeUrl ? beforeUrl.replace(/#.*$/, "") : null;
    const poll = async () => {
      // 先给 loadURL 一个 commit 窗口，避免在旧文档上误判
      await new Promise((r) => setTimeout(r, 150));
      while (!stopped) {
        try {
          const now = wc.getURL() || "";
          const sameBase = beforeBase === now.replace(/#.*$/, "");
          if (sameBase && beforeUrl !== null && now !== beforeUrl) {
            // SPA hash 导航：等 URL 变 + readyState 就绪 + 一小段路由渲染时间
            const st = await evaluate(wc, "({ ready: document.readyState })");
            if (st && (st.ready === "complete" || st.ready === "interactive")) {
              await new Promise((r) => setTimeout(r, 250));
              finish(null);
              return;
            }
          }
        } catch {
          /* 页面可能正在加载，忽略 */
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    poll();
    try {
      trigger();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * dom-ready 即返回（不等图片/iframe/analytics/WebSocket）。
 * 对 MAS/MOM 这类页面，框架先出、几十个接口后到，dom-ready 远早于 did-finish-load。
 */
function waitForDomReady(wc, trigger, timeoutMs = LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error("DOM ready timed out");
      err.status = 504;
      reject(err);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener("dom-ready", onReady);
      wc.removeListener("did-fail-load", onFail);
    };
    const onReady = () => {
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

    wc.once("dom-ready", onReady);
    wc.once("did-fail-load", onFail);
    try {
      trigger();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/** 轮询页面直到条件满足（selector/text/url/role+name）。返回 bool。 */
async function waitForCondition(wc, cond, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let expr;
    if (typeof cond === "string") {
      expr = `(() => { try { return { found: !!document.querySelector(${JSON.stringify(cond)}) }; } catch (e) { return { found: false }; } })()`;
    } else if (cond.selector) {
      expr = `(() => { try { return { found: !!document.querySelector(${JSON.stringify(String(cond.selector))}) }; } catch (e) { return { found: false }; } })()`;
    } else if (cond.text) {
      expr = `(() => { const t = document.body ? (document.body.innerText || document.body.textContent || '') : ''; return { found: t.indexOf(${JSON.stringify(String(cond.text))}) !== -1 }; })()`;
    } else if (cond.url) {
      expr = `(() => { const u = ${JSON.stringify(String(cond.url))}; return { found: location.href.indexOf(u) !== -1 || location.href.startsWith(u) }; })()`;
    } else if (cond.role || cond.name) {
      const t = {};
      if (cond.role) t.role = cond.role;
      if (cond.name) t.name = cond.name;
      expr = `(() => { const E = ${pageEngine(100)}; const r = E.$findBest(${JSON.stringify(t)}); return { found: !!(r.el && r.score >= 100) }; })()`;
    } else {
      return true; // 没有可等待的条件
    }
    try {
      const res = await evaluate(wc, expr);
      if (res && res.found) return true;
    } catch {
      /* 页面可能正在加载，忽略 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
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

/** 真实 Chromium 键盘输入（CDP Input.dispatchKeyEvent），不是合成 DOM 事件。 */
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
      const down = { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: vk };
      const up = { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: vk };
      if (keyName === "Enter") {
        // 真实回车：携带 text 触发原生表单提交
        down.text = "\r";
        down.unmodifiedText = "\r";
      }
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", down);
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", up);
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

// ---------------------------------------------------------------------------
// 动作执行（/execute 与单动作端点的公共逻辑）
// ---------------------------------------------------------------------------

async function runExecute(wc, body) {
  const actions = Array.isArray(body.actions) ? body.actions : [];
  const snapshotId = body.snapshotId || null;
  const meta = snapshotId ? snapshotRegistry.get(snapshotId) : null;
  const max = (meta && meta.max) || SNAPSHOT_MAX;
  return evaluate(wc, executeScript(actions, snapshotId, meta || null, max));
}

/** 把单个动作的失败映射成合适的 HTTP 状态码（404/409/400）。 */
function throwActionError(result, fallbackMessage) {
  const first = result && result.results ? result.results[0] : null;
  const message = first && first.error ? first.error : fallbackMessage;
  const err = new Error(message);
  if (first && /NOT_FOUND|STALE/.test(first.error || "")) err.status = 404;
  else if (first && /AMBIGUOUS/.test(first.error || "")) {
    err.status = 409;
    err.candidates = first.candidates;
  } else err.status = 400;
  throw err;
}

function targetFromBody(body) {
  // 兼容旧 selector / 新 target / ref 三种定位方式
  if (body.ref !== undefined) return { ref: body.ref };
  if (body.target !== undefined) return { target: body.target };
  if (body.selector !== undefined) {
    const sel = String(body.selector);
    // 纯 CSS 选择器同时作为 css（精确 +200）与文本（contains +30）评分
    return { target: { css: sel, name: sel } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

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
          const timeout = Number(body.timeout) || LOAD_TIMEOUT_MS;
          const beforeUrl = wc.getURL() || "";
          // readyWhen: "dom"(默认) | "finish" | {selector|text|url|role,name} | "#app"
          const ready = body.readyWhen !== undefined ? body.readyWhen : body.wait || "dom";
          if (ready === "finish" || ready === "load" || ready === "complete") {
            await waitForLoad(wc, () => wc.loadURL(target.href), timeout);
          } else if (ready === "dom" || ready === "interactive" || typeof ready === "string") {
            await waitForNav(wc, () => wc.loadURL(target.href), { timeoutMs: timeout, beforeUrl });
            if (typeof ready === "string" && ready !== "dom" && ready !== "interactive") {
              const ok = await waitForCondition(wc, ready, Number(body.readyTimeout) || DEFAULT_CONDITION_TIMEOUT_MS);
              if (!ok) {
                const err = new Error(`readyWhen condition not met: ${ready}`);
                err.status = 504;
                throw err;
              }
            }
          } else if (typeof ready === "object") {
            await waitForNav(wc, () => wc.loadURL(target.href), { timeoutMs: timeout, beforeUrl });
            const ok = await waitForCondition(wc, ready, Number(body.readyTimeout) || DEFAULT_CONDITION_TIMEOUT_MS);
            if (!ok) {
              const err = new Error("readyWhen condition not met");
              err.status = 504;
              throw err;
            }
          } else {
            await waitForNav(wc, () => wc.loadURL(target.href), { timeoutMs: timeout, beforeUrl });
          }
          const info = currentInfo(wc);
          if (body.snapshot === true || body.includeSnapshot === true) {
            const snap = await takeSnapshot(wc, Number(body.max) || SNAPSHOT_MAX);
            return sendJson(res, 200, {
              ...info,
              snapshotId: snap.snapshotId,
              snapshot: { url: snap.url, title: snap.title, elements: snap.elements, count: snap.count },
            });
          }
          return sendJson(res, 200, info);
        }

        if (method === "POST" && ["/back", "/forward"].includes(pathname)) {
          const wc = requireActive(getActiveView);
          const isBack = pathname === "/back";
          const canMove = isBack ? wc.canGoBack() : wc.canGoForward();
          if (!canMove) return sendJson(res, 200, { ok: true, moved: false });
          const beforeUrl = wc.getURL() || "";
          await waitForNav(wc, () => (isBack ? wc.goBack() : wc.goForward()), { beforeUrl });
          return sendJson(res, 200, { ok: true, moved: true });
        }

        if (method === "POST" && pathname === "/reload") {
          const wc = requireActive(getActiveView);
          const beforeUrl = wc.getURL() || "";
          await waitForNav(wc, () => wc.reload(), { beforeUrl });
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

        if (method === "GET" && pathname === "/snapshot") {
          const wc = requireActive(getActiveView);
          const max = Math.min(Number(url.searchParams.get("max") || SNAPSHOT_MAX) || SNAPSHOT_MAX, 800);
          const snap = await takeSnapshot(wc, max);
          return sendJson(res, 200, {
            snapshotId: snap.snapshotId,
            url: snap.url,
            title: snap.title,
            signature: snap.signature,
            elements: snap.elements,
            count: snap.count,
            stats: { mode: "electron-webview", semantic: true },
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

        if (method === "POST" && pathname === "/evaluate") {
          // 低层逃生舱：任意 JS 求值（agent 主力工具——canvas 应用/Univer 内部状态读取）。
          // 支持 {"expression":"(a,b) => ..."|"function(a,b){...}"|普通表达式, "args":[...]} 传参，
          // 以及 {"timeoutMs": 5000} 限制执行时长（防死循环/长轮询卡住桥）。
          const body = await readBody(req);
          const wc = requireActive(getActiveView);
          const expr = body.expression || body.script;
          if (!expr) {
            const err = new Error("evaluate needs expression");
            err.status = 400;
            throw err;
          }
          const args = Array.isArray(body.args) ? body.args : [];
          const timeoutMs = Math.min(Number(body.timeoutMs) || 15000, 120000);
          const wrapExpr = (() => {
            const src = String(expr);
            const argsJson = JSON.stringify(args);
            // 形如 (a,b) => … 或 function(a,b){…} 的函数式表达式：带参调用
            if (/^\s*(\([^)]*\)|function\b[^({]*)\(?\s*=>/.test(src) || /^\s*function\b/.test(src)) {
              return `(async () => { const fn = (${src}); return await fn.apply(null, ${argsJson}); })()`;
            }
            return `(async () => { const out = (${src}); return (typeof out === 'function') ? await out.apply(null, ${argsJson}) : out; })()`;
          })();
          let value;
          try {
            value = await Promise.race([
              evaluate(wc, wrapExpr),
              new Promise((_, reject) => setTimeout(() => reject(new Error("evaluate timeout")), timeoutMs)),
            ]);
          } catch (err) {
            // 页面 JS 抛错 / 超时：把信息透传（别让整个请求 500）
            const msg = err && err.message ? err.message : String(err);
            return sendJson(res, 200, {
              ok: false,
              error: msg.includes("evaluate timeout") ? "evaluate timeout (" + timeoutMs + "ms)" : msg.slice(0, 500),
            });
          }
          return sendJson(res, 200, { ok: true, value });
        }

        if (method === "POST" && pathname === "/execute") {
          const body = await readBody(req);
          const wc = requireActive(getActiveView);
          if (!Array.isArray(body.actions) || body.actions.length === 0) {
            const err = new Error("execute needs a non-empty actions array");
            err.status = 400;
            throw err;
          }
          const result = await runExecute(wc, body);
          return sendJson(res, 200, result);
        }

        if (method === "POST" && ["/click", "/type", "/select", "/fill", "/check"].includes(pathname)) {
          const body = await readBody(req);
          const wc = requireActive(getActiveView);
          const actionType = pathname.slice(1);
          const located = targetFromBody(body);
          if (!located) {
            const err = new Error(`${actionType} needs selector/target/ref`);
            err.status = 400;
            throw err;
          }
          const action = { type: actionType === "type" ? "fill" : actionType, ...located };
          if (actionType === "click" || actionType === "select" || actionType === "check") {
            if (body.value !== undefined) action.value = body.value;
          }
          if (actionType === "type") {
            action.value = String(body.text || "");
            // 旧语义：clear=false 追加，clear=true 替换
            if (body.clear !== true) action.append = true;
          }
          if (actionType === "fill") {
            action.value = body.value !== undefined ? String(body.value) : "";
            if (body.clear === false) action.append = true;
          }
          const result = await runExecute(wc, { actions: [action], snapshotId: body.snapshotId });
          const first = result.results && result.results[0];
          if (!result.ok || !first || !first.ok) {
            throwActionError(result, `${actionType} failed`);
          }
          const payload = {
            ok: true,
            action: actionType,
            snapshotInvalidated: result.snapshotInvalidated,
            snapshotId: result.snapshotId,
          };
          if (actionType === "click") {
            payload.tag = first.tag;
            payload.text = first.name;
          } else if (actionType === "type" || actionType === "fill") {
            payload.value = first.value;
          } else if (actionType === "select") {
            payload.method = first.method;
            payload.value = first.value;
          } else if (actionType === "check") {
            payload.checked = first.checked;
          }
          return sendJson(res, 200, payload);
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
          // 可选：先把焦点放到指定元素（ref/target/selector）
          const located = targetFromBody(body);
          if (located) {
            const focusResult = await runExecute(wc, {
              actions: [{ type: "focus", ...located }],
              snapshotId: body.snapshotId,
            });
            if (!focusResult.ok || !(focusResult.results && focusResult.results[0] && focusResult.results[0].ok)) {
              throwActionError(focusResult, "press: focus target failed");
            }
          }
          // 真实 CDP 按键（Enter 携带 \r 触发原生表单提交），失败退回合成事件
          let handled = false;
          try {
            await dispatchInput(wc, { type: "key", key: body.key });
            handled = true;
          } catch {
            handled = false;
          }
          if (!handled) {
            await evaluate(
              wc,
              `(() => {
                const el = document.activeElement;
                if (!el) return { found: false };
                el.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', code: '${key}', bubbles: true, cancelable: true }));
                el.dispatchEvent(new KeyboardEvent('keyup', { key: '${key}', code: '${key}', bubbles: true, cancelable: true }));
                const form = el.closest('form');
                if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                return { found: true };
              })()`
            );
          }
          return sendJson(res, 200, { ok: true, key });
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

        if (method === "POST" && pathname === "/wait") {
          const body = await readBody(req);
          const wc = requireActive(getActiveView);
          if (!body.for && !body.condition) {
            const err = new Error("wait needs for: {selector|text|url|role,name}");
            err.status = 400;
            throw err;
          }
          const result = await runExecute(wc, {
            actions: [{ type: "wait", for: body.for || body.condition, timeout: body.timeout }],
          });
          const first = result.results && result.results[0];
          const satisfied = !!(first && first.ok);
          return sendJson(res, 200, {
            ok: satisfied,
            satisfied,
            timeout: Number(body.timeout) || DEFAULT_CONDITION_TIMEOUT_MS,
            url: result.url,
            title: result.title,
          });
        }

        if (method === "POST" && pathname === "/assert") {
          const body = await readBody(req);
          const wc = requireActive(getActiveView);
          const action = { type: "assert" };
          if (body.text !== undefined) action.text = body.text;
          if (body.target !== undefined) action.target = body.target;
          if (body.state !== undefined) action.state = body.state;
          if (body.value !== undefined) action.value = body.value;
          const result = await runExecute(wc, { actions: [action] });
          const first = result.results && result.results[0];
          return sendJson(res, 200, {
            ok: !!(first && first.ok),
            found: !!(first && first.found),
            detail: first ? first.detail : null,
          });
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
