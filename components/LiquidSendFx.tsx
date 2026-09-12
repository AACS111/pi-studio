"use client";

/**
 * 发送时的液态（Liquid gooey）反馈。
 *
 * 视觉与发送**完全解耦**：onSend 在触发动画的同一帧立即执行，动画只是覆盖层，
 * 绝不延迟交互（外部参考实现里等 1.05s 动画结束才真正发送，手感不可接受）。
 *
 * 三个技术点：
 *  1. gooey 融合 —— 全局 SVG 滤镜 #pi-goo（feGaussianBlur + feColorMatrix alpha 放大，
 *     定义在 app/layout.tsx），`.pi-liquid` 整层挂 `filter: url(#pi-goo)`，
 *     层内的圆/胶囊自动粘成水滴。
 *  2. 液态抽水 —— 主球 + 尾巴 + 两滴水：发送时尾巴 scaleX 猛拉再回弹，主球脉冲。
 *  3. 文字水流 —— 把输入框文字复制成逐字 span 覆盖层，实测每个字位置后算出飞向
 *     发送按钮的相对位移，逐字延迟 + 模糊消散。
 *
 * ── 架构约束（三个坑，务必保持）────────────────────────────────────────
 *  ① **不能把动画挂在 composer 组件里**：`.chat-composer` 由 React 管理，发送瞬间
 *     isStreaming 翻转会重渲染并重写 className，命令式加上的动画类当场被抹掉。
 *  ② **不能挂在 ChatInput 子树里**：空会话发出第一条消息时 ChatWindow 切分支，
 *     ChatInput 被卸载重建，动画随实例销毁（新建会话首条消息永远看不到）。
 *  ③ **不能靠 React state 驱动**：发送同时父级会做一次重渲染（消息列表 + 流式态），
 *     实测特效要等这次重渲染提交后才出现（dev 下 0.6~1.5s 才动，肉眼就是“没反应”）。
 *  所以：宿主做成**挂在 body 上的全局单例**（app/layout.tsx 挂一次）+ **纯命令式 DOM**，
 *  宿主组件挂载后 React 再不碰它的 class/style，动画在下一帧就开始。
 *  位置全部实测（发送按钮 / chip 的 rect），任意宽度都贴合真实控件。
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface BlobVars {
  /** 相对根容器右下角的偏移与按钮尺寸 */
  right: number;
  bottom: number;
  size: number;
}

/** 文字流光最多逐字搬运这么多光字（避免一次挂几百个动画节点、拖慢渲染） */
const MAX_FLOW_CHARS = 100;
/**
 * ★ 设计取向（第三版，最终确定）：不再依赖任何绝对坐标定位。
 *
 * 前两版都在解「把光字从输入框精确送到对话区那条气泡上」这道题，结论是**不可靠**：
 *   · 气泡是 React 异步插入的，点击那一刻它还不存在，只能猜；
 *   · 消息列表会滚动，光字飞到一半目标就变了（实测光字越过气泡冲到标题栏）；
 *   · 首条消息还会重建 composer，连节点带位置一起变。
 * 每加一层补偿（滚动补偿、平滑追踪、真实气泡改道）就多一份抖动和不确定性，
 * 用户看到的就是「飘的位置差距很大」。
 *
 * 现在改成**两个互相解耦的相对动效**，完全不需要知道气泡在哪：
 *   ① 输入框里的字符 → 变成光字，整体**向右飘出**并淡出；
 *   ② 对话区的用户气泡 → 在同一时间段内**从左侧滑入**。
 * 两者时间上衔接（气泡在光字飘到一半时进场），读起来就是
 * 「输入的内容被化成一束光送到右边，落成一条消息」，但不再有任何定位问题。
 */
/** 单颗光字向右飘出的时长（ms） */
const DRIFT_MS = 640;
/** 相邻光字的出发间隔（ms）——错峰形成“一束流光”而不是整块一起动 */
const DRIFT_STAGGER_MS = 18;
/** 整束光流的最大额外滞后（ms）：字数多时压住总时长，避免拖太久 */
const DRIFT_MAX_LAG_MS = 260;
/** 光字向右飘出的最小距离（px）；实际取 max(它, 输入框宽度 × DRIFT_RATIO) */
const DRIFT_MIN_PX = 120;
/**
 * 飘出距离占输入框宽度的比例。
 * 取 0.85 是为了让光字**明显离开输入框**、朝着对话区方向去——
 * 太小（如 0.5）时只在框内滑一小段，读不出“被送到右边”；
 * 太大则会在右侧空白处飞太久。
 */
const DRIFT_RATIO = 0.85;
/** 气泡延迟多久开始从左侧滑入（ms）——与光字飘到一半的时刻对齐 */
const BUBBLE_DELAY_MS = 240;
/** 液态抽水相位总时长（与 globals.css 的 0.9s 关键帧对齐） */
const FLOW_MS = 900;
/** chip 吸附时长（与 pi-chip-absorb 关键帧对齐） */
const CHIP_MS = 620;
/** 发送按钮分裂时长（与 pi-split-* 关键帧对齐） */
const SPLIT_MS = 720;
/** goo 融合距离上限（≤ stdDeviation）：液柱上的小球必须比这更密才能融成一条液体 */
const VEIN_MAX_GAP = 9;
/** 根容器向外扩一圈，给 goo 滤镜的 blur 留扩散空间 */
const GOO_PAD = 30;
const RESPECT_REDUCED_MOTION = false;

function prefersReducedMotion(): boolean {
  if (!RESPECT_REDUCED_MOTION) return false;
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 触发函数注册表挂在 `globalThis` 上，**不能用模块级变量**：宿主（app/layout.tsx）
 * 与调用方（ChatInput）会被打包器分到不同 chunk，各自持有一份模块作用域，
 * 模块级 `playFn` 在调用方那份里永远是 null（曾因此彻底不触发）。
 */
const REGISTRY_KEY = "__piLiquidSendFx";

type FxRegistry = {
  play?: (text: string, textarea: HTMLElement | null, button: HTMLElement | null) => boolean;
  absorb?: (chip: HTMLElement | null, button: HTMLElement | null) => boolean;
  split?: (
    composer: HTMLElement | null,
    anchor: { x: number; y: number } | null,
    buttonSize: number,
    leftTarget: HTMLElement | null,
    rightTarget: HTMLElement | null,
  ) => boolean;
};

function fxRegistry(): FxRegistry {
  const g = globalThis as unknown as Record<string, FxRegistry | undefined>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = {};
  return g[REGISTRY_KEY]!;
}

/** 发送：文字逐字被吸进发送按钮 + 液态块抽水回弹。返回是否真的开始了动画。 */
export function playLiquidSend(
  text: string,
  textarea: HTMLElement | null,
  button: HTMLElement | null,
): boolean {
  try {
    return fxRegistry().play?.(text, textarea, button) ?? false;
  } catch {
    return false; // 纯装饰，失败静默
  }
}

/** 引导 / 后续消息 chip 点击：一滴水从 chip 被吸进发送按钮（不发送） */
export function absorbToSend(chip: HTMLElement | null, button: HTMLElement | null): boolean {
  try {
    return fxRegistry().absorb?.(chip, button) ?? false;
  } catch {
    return false;
  }
}

/**
 * 发送按钮分裂：一团液体从发送按钮向左右渗出，分别落到「引导」与「停止」按钮上。
 * 只做视觉，不改变任何按钮行为（新按钮由 React 同步渲染，动画纯装饰）。
 */
export function splitToTargets(
  composer: HTMLElement | null,
  anchor: { x: number; y: number } | null,
  buttonSize: number,
  leftTarget: HTMLElement | null,
  rightTarget: HTMLElement | null,
): boolean {
  try {
    return fxRegistry().split?.(composer, anchor, buttonSize, leftTarget, rightTarget) ?? false;
  } catch {
    return false;
  }
}

export function LiquidSendFxHost() {
  const rootRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  /** 分裂液柱层：挂在 .pi-liquid 内部，所以自带 goo 滤镜且以 root 为原点。
   * 挂这里（而不是独立 fixed 层）才能与主球、水滴融成同一条液体。 */
  const veinRef = useRef<HTMLDivElement>(null);
  /**
   * 必须等挂载后再 portal：SSR 阶段没有 document，直接 createPortal(document.body)
   * 会抛 “document is not defined” 把整页渲染打挂（曾因此让页面变成 __next_error__）。
   */
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const root = rootRef.current;
    const overlay = overlayRef.current;
    const holder = holderRef.current;
    const veinLayer = veinRef.current;
    if (!root || !overlay || !holder) return;
    const D = window as unknown as Record<string, unknown>;
    D.__fxHostReady = true;

    /**
     * 每个相位独立计时——曾经共用一个 phaseTimer，导致先起的 pi-flow 的
     * “到点摘类”计时器被后起的 pi-split 清掉：pi-flow 永远留在 root 上，
     * 发送按钮那一团液体收尾后不会消失（实测 t2600 时 blob 还挂在按钮上）。
     */
    const phaseTimers = new Map<string, number>();
    /** 上一次分裂留下的液柱清理函数（连发时先把上一批液柱拆干净） */
    let splitCleanup: (() => void) | null = null;
    /** 上一次“气泡等水流到位再显形”的清理函数 */
    let bubbleReveal: (() => void) | null = null;
    /** 上一次逐帧水流驱动的取消函数 */
    let driveStop: (() => void) | null = null;
    let flowTimer: number | null = null;
    let restoreTimer: number | null = null;
    /** 几何跟随循环（composer 位移时重贴液态层 + 文字流） */
    let followRaf = 0;
    /** 被本次动画隐藏了文字的 textarea（动画收尾时无条件恢复，避免输入框卡在不可见） */
    let hiddenTextarea: HTMLElement | null = null;

    const restoreTextarea = () => {
      if (!hiddenTextarea) return;
      hiddenTextarea.style.opacity = "";
      hiddenTextarea = null;
    };

    /**
     * 重贴“文字流→按钮中心”的**位移量**，不重算字位置（字位置在第一次 layoutFlow 时已缓存）。
     * 只在命中测试矩形变化时调用，避免 rAF 里每帧做一次全文排版。
     */
    const trackComposerBounds = (
      composer: HTMLElement,
      c: DOMRect,
      rel: { right: number; bottom: number; width: number },
    ) => {
      root.style.left = `${c.left - GOO_PAD}px`;
      root.style.top = `${c.top - GOO_PAD}px`;
      root.style.width = `${c.width + GOO_PAD * 2}px`;
      root.style.height = `${c.height + GOO_PAD * 2}px`;
      root.style.setProperty("--pi-goo-r", `${Math.max(4, Math.round(rel.right)) + GOO_PAD}px`);
      root.style.setProperty("--pi-goo-b", `${Math.max(4, Math.round(rel.bottom)) + GOO_PAD}px`);
      root.style.setProperty("--pi-goo-size", `${Math.max(20, Math.round(rel.width))}px`);
    };

    /**
     * 让根容器贴住目标 composer（fixed + 实测坐标），返回按钮中心在视图口中的位置。
     *
     * ★ 关键：只缓存**相对 composer 的偏移**（相对右下角的内缩量），绝不缓存按钮的绝对坐标。
     *   发送首条消息时 composer 会整块位移（实测 top 477 → 800），若把旧按钮的绝对
     *   bottom 与新 composer 的 bottom 相减，会算出 `--pi-goo-b: 362px` 这种离谱值，
     *   主球被画到输入框上方 300px 处（实测 blob y=515 而 composer 在 800）。
     *   相对偏移则可随 composer 一起平移，位移后位置依旧正确。
     *
     * button 可为 null：发送后发送按钮会被「引导/后续/停止」按钮组替换（React 卸载旧按钮），
     * 此时沿用最后量到的相对偏移即可。
     */
    let lastRel: { right: number; bottom: number; width: number } | null = null;
    const anchorTo = (composer: HTMLElement, button: HTMLElement | null) => {
      const c = composer.getBoundingClientRect();
      const b = button && button.isConnected ? button.getBoundingClientRect() : null;
      // 只信任“确实落在本 composer 内”的按钮矩形；否则视为旧布局的残留，用相对偏移沿用
      const fresh = !!b && b.width > 0
        && b.right <= c.right + 1 && b.bottom <= c.bottom + 1
        && b.right >= c.left && b.bottom >= c.top;
      if (fresh) {
        lastRel = { right: c.right - b!.right, bottom: c.bottom - b!.bottom, width: b!.width };
      }
      const rel = lastRel;
      if (!rel) return null;
      const Dl = window as unknown as Record<string, unknown>;
      Dl.__anchored = { c: { l: Math.round(c.left), t: Math.round(c.top), w: Math.round(c.width), h: Math.round(c.height) }, b: { l: Math.round(b ? b.left : -1), w: Math.round(rel.width) }, composerCls: composer.className, btnTitle: button?.getAttribute("title") ?? "(detached)" };
      trackComposerBounds(composer, c, rel);
      // 主球比按钮大一圈：blob 外缘必须露到按钮外面，否则与按钮同尺寸、同 accent 色，
      // 而本层 z-index 低于卡片内控件 = 完全被按钮盖住（实测只露几像素，肉眼只见按钮脉动）。
      // 同时整体朝左上偏一点，读成“液体从按钮里涌出”（尾巴在左侧，方向一致）。
      root.style.setProperty("--pi-goo-bleed", `${Math.max(6, Math.round(rel.width * 0.3))}px`);
      root.style.setProperty("--pi-goo-off", `${Math.max(1, Math.round(rel.width * 0.08))}px`);
      return { x: c.right - rel.right - rel.width / 2, y: c.bottom - rel.bottom - rel.width / 2 };
    };

    /** 播放一个动画相位：先摘旧类、强制回流，保证连点也能从头播 */
    /**
     * 播放一个动画相位：先摘旧类、强制回流，保证连点也能从头播。
     * 只摘同名类（不再清掉其他相位）——发送时 pi-flow（文字流）与 pi-split（按钮分裂）
     * 是同一帧开始的，之前把所有类一起清掉会把刚起的文字流直接抹掉。
     */
    const runPhase = (cls: "pi-flow" | "pi-chip-flow" | "pi-split", ms: number) => {
      root.classList.remove(cls);
      // 强制回流：连续触发时保证关键帧从头跑，而不是被浏览器合并
      void root.offsetWidth;
      root.classList.add(cls);
      const previous = phaseTimers.get(cls);
      if (previous) window.clearTimeout(previous);
      phaseTimers.set(cls, window.setTimeout(() => {
        root.classList.remove(cls);
        phaseTimers.delete(cls);
      }, ms));
    };

    /**
     * 把流光层贴到当前 textarea 位置，并记录**实时的起点与终点**（视口坐标）。
     * 可重复调用（逐帧循环每帧调），所以气泡出现/列表滚动后终点会自动跟上。
     *
     * ★ 不做任何 transform 写入（那是 driveFlow 的职责）——只负责几何与排版。
     */
    /**
     * 把光字覆盖层贴到 textarea 上并测量每个字的**静态排版位置**。
     * ★ 不再计算任何“终点”：光字只做相对飘移（见 driveFlow），
     *   所以这里只关心起点排版，不需要知道气泡在哪。
     */
    const layoutFlow = (
      composer: HTMLElement,
      textarea: HTMLElement,
      button: HTMLElement | null,
      spans: HTMLElement[],
    ) => {
      // 游离节点防御：composer/textarea 被 React 卸载（首条消息切分支）时 rect 全 0
      if (!composer.isConnected || !textarea.isConnected) return false;
      const probe = composer.getBoundingClientRect();
      if (probe.width <= 0 || probe.height <= 0) return false;
      // anchorTo 负责把液态层（按钮那团水）贴到 composer 上，顺带写入 --pi-goo-*
      // 与按钮的包围盒（最后一次量到的为准）。
      // ★ 必须把真实 button 传进来：anchorTo 在第一次调用时靠它建立相对偏移基线，
      //   传 null 会让它拿不到基线而直接返回 null（play 静默失败、动效完全不出现）。
      if (!anchorTo(composer, button)) return false;
      const cs = window.getComputedStyle(textarea);
      const tRect = textarea.getBoundingClientRect();
      if (tRect.width <= 0 || tRect.height <= 0) return false;
      Object.assign(overlay.style, {
        left: `${tRect.left}px`,
        top: `${tRect.top}px`,
        width: `${tRect.width}px`,
        height: `${tRect.height}px`,
        padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        textAlign: cs.textAlign,
        display: "block",
      });
      // 光字直径 = 行高的 1.05 倍：看得清，又不至于盖满整行
      const moteSize = Math.max(11, Math.min(28, Math.round(tRect.height * 1.05)));
      holder.style.setProperty("--pi-mote-size", `${moteSize}px`);
      holder.style.lineHeight = `${tRect.height}px`;
      spans.forEach((span) => {
        // 静态排版位置只量一次并缓存：重贴时 span 带着 transform，
        // 再测 getBoundingClientRect 会把位移算进去。
        let ox = span.dataset.ox;
        let oy = span.dataset.oy;
        if (ox === undefined || oy === undefined) {
          const r = span.getBoundingClientRect();
          ox = String(r.left + r.width / 2 - tRect.left);
          oy = String(r.top + r.height / 2 - tRect.top);
          span.dataset.ox = ox;
          span.dataset.oy = oy;
        }
      });
      holder.dataset.width = String(tRect.width);
      return true;
    };

    /**
     * 逐帧驱动「光字向右飘出」。
     *
     * ★ 为什么这次不用绝对坐标：见 MAX_FLOW_CHARS 上方那段设计说明。
     *   光字只沿「右侧 + 轻微上浮」这条相对路径飘走并淡出，
     *   不需要知道对话区气泡在哪，因此**永远不会飘错位置**。
     *
     * 运动构成（让“一束光”而不是“一排平移的圆点”）：
     *   · 位移：向右 Dx（越长越远）+ 向上 Dy（轻微，像热气上升）
     *   · 错峰：每颗延迟 i * DRIFT_STAGGER_MS，形成流水般的队列
     *   · 尺寸：先鼓一下再收细（被抽走的体积感）
     *   · 透明度：后半段淡出
     */
    const driveFlow = (spans: HTMLElement[], startAt: number) => {
      const total = Math.max(1, spans.length);
      // 字数多时压缩错峰，避免整束光拖太久（总滞后上限 DRIFT_MAX_LAG_MS）
      const stagger = Math.min(DRIFT_STAGGER_MS, DRIFT_MAX_LAG_MS / total);
      const lastStart = stagger * total;
      const totalTime = DRIFT_MS + lastStart + 80;
      // 飘出距离：取输入框宽度的固定比例与下限的较大值。
      // ★ 始终是**相对**距离，不依赖任何绝对坐标 —— 所以永远不会“飘错位置”。
      const boxWidth = Number(holder.dataset.width ?? 0);
      const Dx = Math.max(DRIFT_MIN_PX, boxWidth * DRIFT_RATIO);
      // 上浮幅度：略向上并随字序递增，形成一道向右上方斜掠的光束
      const riseFor = (i: number) => 8 + (i % 6) * 6;
      let raf = 0;

      const ease = (t: number) => 1 - Math.pow(1 - t, 2.6);
      const step = () => {
        const elapsed = performance.now() - startAt;
        if (elapsed > totalTime) {
          raf = 0;
          return;
        }
        for (let i = 0; i < spans.length; i += 1) {
          const span = spans[i];
          const local = (elapsed - i * stagger) / DRIFT_MS;
          if (local <= 0) {
            // 还没轮到：原位不可见（避免一开始所有光字同时亮起）
            span.style.opacity = "0";
            span.style.transform = "translate(0px, 0px) scale(0.5)";
            continue;
          }
          const t = Math.min(1, local);
          const e = ease(t);
          const dx = Dx * e;
          const dy = -riseFor(i) * e;
          // 尺寸：先鼓（0.5→1.15）再收（→0.35）
          const scale = t < 0.22 ? 0.5 + (t / 0.22) * 0.65 : 1.15 - ((t - 0.22) / 0.78) * 0.8;
          // 透明度：入流时快速显现，尾段淡出
          const op = t < 0.12 ? t / 0.12 : Math.max(0, 1 - Math.max(0, (t - 0.5) / 0.5) * 1.05);
          span.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(3)})`;
          span.style.opacity = String(Math.max(0, Math.min(1, op)).toFixed(3));
        }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    };

    /**
     * 让新出现的用户气泡**延迟一点、从左侧滑入**（替代旧的“等流光汇到位”）。
     *
     * 为什么改成这样：气泡的目标位置无法在点击时可靠得知（React 异步插入 + 列表滚动），
     * 所以不再让光字去追气泡，而是反过来——**气泡自己从左侧进来**，
     * 与光字向右飘出在时间上衔接，形成“左边进、右边出”的完整叙事。
     *
     * 实现仍用 MutationObserver：它的回调是**微任务**，在 React 提交 MutationRecord 之后、
     * 浏览器下一次渲染之前同步执行，所以在这里写 opacity:0 / 起点位移仍来得及——
     * 气泡不会先以最终状态闪一帧再开始动。
     *
     * 安全网：① 兜底 1.6s 必定还原；② 用 setTimeout 而非 rAF（后台标签页 rAF 不跑）；
     * ③ 卸载时跑一遍还原，避免残留内联样式。
     */
    const holdBubbleUntilArrival = (delayMs: number) => {
      bubbleReveal?.();
      const found = new Set<HTMLElement>();
      let revealed = false;
      let observer: MutationObserver | null = null;
      let startTimer = 0;
      let stopTimer = 0;
      /** 本轮要找的“新”气泡：开始时已有的那些是历史消息，不算 */
      const preexisting = new Set(document.querySelectorAll<HTMLElement>("[data-pi-user-msg]"));

      const hide = (el: HTMLElement) => {
        if (found.has(el) || revealed) return;
        found.add(el);
        el.style.opacity = "0";
        el.classList.add("pi-bubble-in-left-pending");
      };
      const collect = () => {
        for (const el of document.querySelectorAll<HTMLElement>("[data-pi-user-msg]")) {
          if (!preexisting.has(el)) hide(el);
        }
      };

      const reveal = () => {
        if (revealed) return;
        revealed = true;
        observer?.disconnect();
        observer = null;
        window.clearTimeout(startTimer);
        window.clearTimeout(stopTimer);
        found.forEach((el) => {
          if (!el.isConnected) return;
          el.style.opacity = "";
          el.classList.remove("pi-bubble-in-left-pending");
          el.classList.add("pi-bubble-in-left");
          window.setTimeout(() => el.classList.remove("pi-bubble-in-left"), 620);
        });
        found.clear();
        bubbleReveal = null;
      };

      collect();
      observer = new MutationObserver(() => {
        collect();
        // 气泡一到就立刻安排入场（不必等满 delayMs），让节奏更跟手
        if (!revealed && found.size) {
          window.clearTimeout(startTimer);
          startTimer = window.setTimeout(reveal, Math.max(60, delayMs - 180));
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      startTimer = window.setTimeout(reveal, delayMs);
      stopTimer = window.setTimeout(reveal, 1600);
      bubbleReveal = reveal;
    };

    const registry = fxRegistry();
    registry.play = (text, textarea, button) => {
      if (!text.trim() || prefersReducedMotion()) return false;
      const composer = textarea?.closest(".chat-composer") as HTMLElement | null;
      if (!composer || !textarea) return false;

      // 气泡从左侧滑入（与光字向右飘出衔接）
      holdBubbleUntilArrival(BUBBLE_DELAY_MS);

      // 逐字生成光字（上限 MAX_FLOW_CHARS，避免一次挂太多动画节点）
      holder.textContent = "";
      const chars = [...text].slice(0, MAX_FLOW_CHARS);
      const frag = document.createDocumentFragment();
      const spans: HTMLElement[] = [];
      chars.forEach((ch, i) => {
        const span = document.createElement("span");
        span.className = "pi-flow-char";
        // 空白不产光字（否则一束光里夹空洞），但仍占位保持排版一致
        span.textContent = ch === " " ? " " : ch;
        span.dataset.blank = ch === " " ? "1" : "0";
        // 逐字尺寸抖动（确定性伪随机）：让光字大小错落、有节奏
        const jitter = 0.62 + (((i * 37 + 13) % 57) / 100);
        span.style.setProperty("--pi-mote-scale", jitter.toFixed(2));
        spans.push(span);
        frag.appendChild(span);
      });
      holder.appendChild(frag);

      // 首条消息时 composer 会被 React 整块重建（引导提示行消失、列表切分支），
      // 发送按钮也会从「发送」换成「引导/后续/停止」。所以给两者都打临时 id，
      // 跟随循环里据此重新抓当前节点（anchorTo 需要真实按钮包围盒做基线，
      // 传 null 会让它拿不到基线直接返回 null，play 静默失败、动效完全不出现）。
      const flowTextareaId = `pi-flow-ta-${Date.now().toString(36)}`;
      const flowButtonId = `pi-flow-btn-${Date.now().toString(36)}`;
      textarea.id = flowTextareaId;
      if (button) button.id = flowButtonId;
      let currentTextarea: HTMLElement | null = textarea;
      let currentButton: HTMLElement | null = button;
      let cachedComposer: HTMLElement | null = composer;
      const composer0 = composer;
      const textarea0 = textarea;
      const button0 = button;
      if (followRaf) cancelAnimationFrame(followRaf);
      if (driveStop) driveStop();
      driveStop = null;
      const followStart = performance.now();
      let followKey = "";
      let followTick = 0;
      /**
       * 解析“当前真实存在”的输入框。
       * ① 先按临时 id 找；② 找不到说明节点被 React 重建、连 id 一起丢了 ——
       * 退回按结构解析（当前可见的 .chat-composer 里的 textarea）并把 id 补上。
       */
      const resolveLiveTextarea = (): HTMLElement | null => {
        const byId = document.getElementById(flowTextareaId) as HTMLElement | null;
        if (byId) return byId;
        const list = document.querySelectorAll<HTMLElement>(".chat-composer textarea");
        const live = list.length ? list[list.length - 1] : null;
        if (live) live.id = flowTextareaId;
        return live;
      };
      if (!layoutFlow(composer, textarea, button, spans)) return false;
      const follow = () => {
        // 首条消息时父级会把整个 composer 区块重建，启动时缓存的节点会变成游离节点：
        // rect 全 0 → 液态层被写到视口外。所以动画期间每帧重新解析一次当前节点。
        const liveTextarea = resolveLiveTextarea();
        if (liveTextarea && liveTextarea !== currentTextarea) {
          if (hiddenTextarea && hiddenTextarea !== liveTextarea) hiddenTextarea.style.opacity = "";
          liveTextarea.style.opacity = "0";
          hiddenTextarea = liveTextarea;
          currentTextarea = liveTextarea;
          cachedComposer = liveTextarea.closest(".chat-composer") as HTMLElement | null;
        }
        const composerNow = cachedComposer ?? composer0;
        const textareaNow = currentTextarea ?? textarea0;
        // 发送按钮可能已被换成 引导/后续/停止：按 id 反查，找不到就沿用旧引用
        currentButton =
          (document.getElementById(flowButtonId) as HTMLElement | null) ??
          (currentButton && currentButton.isConnected ? currentButton : null);
        const buttonNow = currentButton ?? button0;
        followTick += 1;
        // 廉价“布局是否变了”探针：offsetWidth/Height 不触发重排；每 2 帧核对一次
        const cheap = `${composerNow.offsetWidth}x${composerNow.offsetHeight}`;
        if (cheap !== followKey || followTick % 2 === 0) {
          const c = composerNow.getBoundingClientRect();
          // 游离节点（刚被卸载）rect 全为 0：跳过这一帧，保留上次正确几何
          if (c.width > 0 && c.height > 0) {
            const key = `${Math.round(c.left)},${Math.round(c.top)},${Math.round(c.width)},${Math.round(c.height)}`;
            if (key !== followKey) {
              followKey = key;
              layoutFlow(composerNow, textareaNow, buttonNow, spans);
            }
          }
        }
        followRaf = performance.now() - followStart < FLOW_MS ? requestAnimationFrame(follow) : 0;
      };
      followRaf = requestAnimationFrame(follow);
      // 收尾时清掉临时 id（它们只服务于跟随循环）
      window.setTimeout(() => {
        document.getElementById(flowTextareaId)?.removeAttribute("id");
        document.getElementById(flowButtonId)?.removeAttribute("id");
      }, FLOW_MS + 500);

      runPhase("pi-flow", FLOW_MS);
      // 文字可见性由本层独占（不走 React state）：
      // 发送同时父级会重渲染，若等 React 提交才隐藏，真实文字会与覆盖层重叠一帧以上
      // （dev 下实测近 400ms，肉眼就是“双份文字”）。这里同步隐掉，收尾无条件恢复。
      if (hiddenTextarea && hiddenTextarea !== textarea) restoreTextarea();
      textarea.style.opacity = "0";
      hiddenTextarea = textarea;
      // 光字向右飘出（相对位移，不需要任何绝对坐标）
      driveStop = driveFlow(spans, performance.now());

      if (flowTimer) window.clearTimeout(flowTimer);
      flowTimer = window.setTimeout(() => {
        holder.textContent = "";
        overlay.style.display = "none";
      }, DRIFT_MS + DRIFT_MAX_LAG_MS + 160);
      if (restoreTimer) window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(restoreTextarea, DRIFT_MS + DRIFT_MAX_LAG_MS + 160);
      return true;
    };

    registry.absorb = (chip, button) => {
      if (prefersReducedMotion() || !chip) return false;
      const composer = chip.closest(".chat-composer") as HTMLElement | null;
      if (!composer) return false;
      const target = anchorTo(composer, button);
      if (!target) return false;

      const lRect = root.getBoundingClientRect();
      const cRect = chip.getBoundingClientRect();
      const cx = cRect.left + cRect.width / 2 - lRect.left;
      const cy = cRect.top + cRect.height / 2 - lRect.top;
      const tx = target.x - lRect.left;
      const ty = target.y - lRect.top;
      root.style.setProperty("--pi-chip-x", `${Math.round(cx)}px`);
      root.style.setProperty("--pi-chip-y", `${Math.round(cy)}px`);
      root.style.setProperty("--pi-chip-dx", `${Math.round(tx - cx)}px`);
      root.style.setProperty("--pi-chip-dy", `${Math.round(ty - cy)}px`);
      root.style.setProperty("--pi-chip-w", `${Math.max(12, Math.round(cRect.height * 0.6))}px`);

      runPhase("pi-chip-flow", CHIP_MS);
      chip.classList.add("pi-chip-squish");
      window.setTimeout(() => chip.classList.remove("pi-chip-squish"), 180);
      return true;
    };

    /**
     * 在 .pi-liquid（**以 root 为原点**、自带 goo 滤镜）里铺一条从 (x1,y1) 到 (x2,y2)
     * 的液柱：沿直线撒一串圆形小球，相邻球心间距 < 融合半径，整条被融成连续液体。
     * 调用方传入的必须是 **root 相对坐标**（见 registry.split 里的换算说明）。
     */
    const buildVein = (
      container: HTMLElement,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      thick: number,
    ): HTMLElement[] => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1) return [];
      const count = Math.min(48, Math.max(3, Math.ceil(len / Math.max(2, Math.min(thick * 0.5, VEIN_MAX_GAP)))));
      const nodes: HTMLElement[] = [];
      for (let i = 0; i <= count; i += 1) {
        const k = i / count;
        // ★ 由粗到细收束（源头 100% → 末端 42%）：等粗的柱子读起来像管道，
        //   收束之后才是“水被抽成一条丝拉过去”。goo 融合会把这串变径球抹成平滑锥形。
        const size = thick * (1 - 0.58 * k);
        const dot = document.createElement("span");
        dot.className = "pi-vein-dot";
        dot.style.left = `${(x1 + (x2 - x1) * k - size / 2).toFixed(1)}px`;
        dot.style.top = `${(y1 + (y2 - y1) * k - size / 2).toFixed(1)}px`;
        dot.style.width = `${size.toFixed(1)}px`;
        dot.style.height = `${size.toFixed(1)}px`;
        container.appendChild(dot);
        nodes.push(dot);
      }
      return nodes;
    };

    /**
     * 发送按钮分裂：主球在发送按钮上鼓一下，同时向左右目标按钮各“拉”出一条液柱，
     * 水真的沿柱流过去，末端凝成新按钮的位置。
     *
     * ★ 为何不能只挪一滴水（旧实现就是）：goo 的融合半径只有 stdDeviation 量级
     *   （实测 stdDeviation=8 时上限 ~12px）。主球中心到引导按钮中心 60px+，
     *   水滴一路飞过去全程与主球脱离 → 没有桥、没有拉丝，观感只是“小圆点飘走”。
     *   铺一条液柱把这段路填满，两端始终与主球/落点交融，才是“水分流”。
     */
    registry.split = (composer, anchor, buttonSize, leftTarget, rightTarget) => {
      if (prefersReducedMotion() || !composer || !anchor) return false;
      const center = anchor;

      const targetCenter = (target: HTMLElement | null) => {
        if (!target) return null;
        const r = target.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };

      const left = targetCenter(leftTarget);
      const right = targetCenter(rightTarget);
      const dxTo = (t: { x: number; y: number } | null, fallback: number) =>
        t ? Math.round(t.x - center.x) : fallback;
      const thick = Math.max(6, buttonSize * 0.36);

      // ★ 坐标系换算：液柱挂在 .pi-liquid 里（以 root 原点为基准，且带 goo 滤镜），
      //   所以要把“视口坐标”减掉 root 自己的左上角。同时主球在**本层内部**的
      //   真实中心是 anchorTo 返回的视口坐标减 root 原点（它比按钮大一圈且偏了
      //   bleed/off，直接用按钮中心会让液柱与主球错开）。
      const rRect = root.getBoundingClientRect();
      const toLocal = (p: { x: number; y: number }) => ({ x: p.x - rRect.left, y: p.y - rRect.top });
      const origin = toLocal(center);
      const dots: HTMLElement[] = [];
      if (veinLayer && left) {
        const t = toLocal(left);
        dots.push(...buildVein(veinLayer, origin.x, origin.y, t.x, t.y, thick));
      }
      if (veinLayer && right) {
        const t = toLocal(right);
        dots.push(...buildVein(veinLayer, origin.x, origin.y, t.x, t.y, thick));
      }
      // 液柱生命周期与 pi-split 相位一致；提前开始收缩，让水体“凝”到按钮上
      const shrinkAt = window.setTimeout(() => {
        dots.forEach((dot) => {
          dot.style.transform = "scale(0.18)";
          dot.style.opacity = "0";
        });
      }, SPLIT_MS * 0.62);
      const cleanup = window.setTimeout(() => {
        window.clearTimeout(shrinkAt);
        dots.forEach((dot) => dot.remove());
      }, SPLIT_MS + 60);
      if (splitCleanup) splitCleanup();
      splitCleanup = () => {
        window.clearTimeout(shrinkAt);
        window.clearTimeout(cleanup);
        dots.forEach((dot) => dot.remove());
      };
      // 液柱出现时的“注水”感：小球从 0.55 弹到 1，避免整条柱子瞬间出现
      dots.forEach((dot) => {
        dot.animate(
          [{ transform: "scale(0.55)" }, { transform: "scale(1)" }],
          { duration: SPLIT_MS * 0.3, easing: "ease-out", fill: "both" },
        );
      });

      root.style.setProperty("--split-a-dx", `${dxTo(left, -60)}px`);
      root.style.setProperty("--split-b-dx", `${dxTo(right, 60)}px`);
      // 水滴起点落在主球外沿，避免与主球重叠（仅在融合半径内小幅度渗出）
      root.style.setProperty("--pi-goo-split", `${Math.max(18, buttonSize * 0.8).toFixed(0)}px`);

      runPhase("pi-split", SPLIT_MS);
      return true;
    };

    return () => {
      registry.play = undefined;
      registry.absorb = undefined;
      registry.split = undefined;
      if (splitCleanup) splitCleanup();
      if (bubbleReveal) bubbleReveal();
      splitCleanup = null;
      bubbleReveal = null;
      phaseTimers.forEach((id) => window.clearTimeout(id));
      phaseTimers.clear();
      if (flowTimer) window.clearTimeout(flowTimer);
      if (restoreTimer) window.clearTimeout(restoreTimer);
      if (followRaf) cancelAnimationFrame(followRaf);
      if (driveStop) driveStop();
      driveStop = null;
      restoreTextarea();
    };
  }, [mounted]);

  if (!mounted) return null;

  return createPortal(
    // 纯静态骨架：挂载后 React 不再碰它（动画全部由上面的 effect 命令式驱动）
    <div className="pi-liquid-root" ref={rootRef} aria-hidden="true">
      <div className="pi-liquid">
        <div className="pi-vein-layer" ref={veinRef} />
        <span className="pi-liquid-tail" />
        <span className="pi-liquid-drop-b" />
        <span className="pi-liquid-drop-a" />
        <span className="pi-liquid-main" />
        <span className="pi-liquid-ghost" />
        <span className="pi-liquid-split-a" />
        <span className="pi-liquid-split-b" />
        <span className="pi-liquid-chip" />
      </div>
      {/* 水珠流：**不放进 .pi-liquid**。水珠各自带高光/投影，进 goo 滤镜会被模糊
          成一团色块（滤镜会把每个水球的细节融掉）；放无滤镜的根层反而球体更清晰。
          它们的“汇合成流”感由逐字错峰飞行 + 沿路径的浮沉曲线给出。 */}
      <div className="pi-liquid-wave" />
      <div className="pi-flow-text" ref={overlayRef}>
        <div ref={holderRef} />
      </div>
    </div>,
    document.body,
  );
}
