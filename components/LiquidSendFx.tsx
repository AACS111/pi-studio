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
 *   ① 输入框里的字符 → 变成**发光文字**（保留字形 + accent 辉光），
 *      沿波浪轨迹**向右飘出**、逐渐虚化消散；
 *   ② 对话区的用户气泡 → 等光字飘过大半之后，从**右侧**滑入。
 * 两者时间上刻意错开，读起来就是
 * 「输入的内容化成一束光飞到右边，再从右边卷回来落成一条消息」，且不再有任何定位问题。
 * （该节奏与用户提供的参考 demo 保持一致：文字流 ~1.0s，消息在水流将尽时落定。）
 */
/** 单颗光字向右飘出的时长（ms）——与参考 demo 的 1.0s 对齐 */
const DRIFT_MS = 1000;
/** 相邻光字的出发间隔（ms）——错峰形成“一束流光”而不是整块一起动 */
const DRIFT_STAGGER_MS = 18;
/** 整束光流的最大额外滞后（ms）：字数多时压住总时长，避免拖太久 */
const DRIFT_MAX_LAG_MS = 240;
/** 光字向右飘出的最小距离（px）；实际取 max(它, 输入框宽度 × DRIFT_RATIO) */
const DRIFT_MIN_PX = 220;
/**
 * 飘出距离占输入框宽度的比例（要 **明显飞出去**：demo 里横向飞了大半屏）。
 * 上限 DRIFT_MAX_PX 防止超宽屏时飞出视口、读不出“被送走”的落点。
 */
const DRIFT_RATIO = 1.15;
const DRIFT_MAX_PX = 620;
/** 后字比前字多飞一点，不让整行字在终点叠成一个点（demo 也有这个 1.3px/字 的散开） */
const DRIFT_SPREAD_PER_CHAR = 1.6;
const DRIFT_SPREAD_MAX = 40;
/** 气泡延迟多久开始从右侧滑入（ms）——与光字飘到“大半程”的时刻对齐 */
const BUBBLE_DELAY_MS = 780;
/**
 * 气泡被晚插入时，发现它之后至少再等这么久才放它进场（ms）。
 * 留一点“落定”的余地，避免最后一刻才被找到、直接就弹出来。
 */
const BUBBLE_SETTLE_MS = 140;
/** 液态抽水相位总时长（与 globals.css 的 0.9s 关键帧对齐） */
const FLOW_MS = 900;
/** chip 吸附时长（与 pi-chip-absorb 关键帧对齐） */
const CHIP_MS = 620;
/**
 * ── 发送按钮「一分三」（第八版 · 当前定稿）────────────────────────────
 * 前六版都在往按钮上“运液体”（液柱 / 水珠 / 蓝色光点），用户始终觉得
 * 「不搭配、像在按钮上涂了一层颜料」。原因很清楚：**分裂动作的主角不是液体，
 * 而是按钮本身**。液体飞过按钮所在的整片区域，颜色再准也和按钮的材质无关。
 *
 * 分裂只做**按钮自己的形变**，不引入任何新颜色。三条硬约束（每条都是实测踩出来的）：
 *   ① 圆钮必须在**用户点的那一颗**旗下 —— 空会话发第一条消息时 composer 会整体
 *      下移（y 477 → 800），用点击瞬间的旧坐标会画出一个孤零零飘在对话区中部
 *      的蓝球，与真正落位的三颗按钮差 300px（这就是“分裂很怪”的主因）。
 *   ② 圆钮里同时只允许出现**一种**按钮：蓝（发送）缩没之后红（停止）才长出来。
 *      蓝 240ms / 红 170ms 就起步时，重叠期两色相加 = 紫，正是“像涂了颜料”。
 *   ③ 另外两颗按钮飞行途中必须**先隐形**：三颗都从圆钮出发，可见地飞就会在
 *      半空叠成重影（实测 t≈240ms「引导」与「后续消息」完全叠字）。
 *
 * 时间轴（可对着逐帧截图核对）：
 *   t=0          圆钮轻吞一下（ghost 缩放脉冲 + 一圈 accent 涟漪）
 *   t=0~170ms    蓝向内缩成小点淡出（始终在最上层）
 *   t=170~290ms  红从中心长到满格 —— 蓝已走干净，不会叠出紫
 *   t=40ms 起    引导 / 后续消息 从圆钮底下被抽出（起点位移 = 自己到圆钮中心的
 *                距离，FLIP）；offset 0~0.36 恒 opacity 0，飞过大半才凝出
 *   t=+530ms     全部落位，flushSplit 解锁交互（与 splitTotalMs 共用常量）
 * ghost 是发送/停止按钮的**真实 DOM 克隆**（真实底色、边框、图标、阴影），
 * 所以任何主题下都和界面严丝合缝——这是“不搭配”的根治办法。
 * 液体层只保留输入框文字流光那部分（pi-flow）。
 */
/** 单颗按钮“抽出/落位”的时长（ms） */
const MORPH_MS = 300;
/**
 * 相邻按钮抽出的间隔（ms）—— 错峰才有“一颗一颗分离”的队列感。
 * ★ 必须大到“前一颗基本就位、后一颗才现身”：三颗按钮都从圆钮出发，
 *   间隔太小时两颗会在半空中叠在一起，文字糊成一团（75ms + 360ms 的旧参数，
 *   实测 t≈240ms 一帧里「引导」和「后续消息」完全重叠）。
 */
const MORPH_STAGGER_MS = 110;
/** 点击之后先让圆钮吞一下，再抽第一颗按钮（ms） */
const MORPH_LEAD_MS = 40;
/** 圆钮里的颜色交替（蓝→红）：蓝必须**先走干净** */
const MORPH_CROSS_MS = 170;
/**
 * 红顶上来晚一点：**必须 >= MORPH_CROSS_MS**。
 * 早于它就会出现“蓝还在、红已起”的重叠期，两色相加是紫 —— 旧值 170ms 起步、
 * 蓝要 240ms 才结束，实测 t≈120ms 圆钮是紫的（用户原话“像涂了一层颜料”）。
 */
const MORPH_TARGET_DELAY_MS = 170;
/** 红长满的时长（ms）：稍慢于蓝的收缩，收尾才不仓促 */
const MORPH_TARGET_MS = 120;
/** 全部落位后 ghost 多留一帧再摘掉（ms），避免与真实按钮交接时闪一下 */
const MORPH_HOLD_MS = 120;
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
    /** 点击那一刻发送按钮的 DOM 克隆——圆钮形变的「蓝」那一半（真实底色/图标） */
    originVisual?: HTMLElement | null,
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
 * 发送按钮分裂（视觉）：圆钮原地形变（蓝→红）+ 其余按钮从圆钮底下被抽出来。
 * 只做视觉，不改变任何按钮行为（新按钮由 React 同步渲染，动画纯装饰）。
 *
 * @param originVisual 点击那一刻发送按钮的克隆。**必须在点击回调里同步克隆**——
 *   流式态一翻转，真实发送按钮就被 React 卸载了（这是本项目踩过的坑）。
 */
export function splitToTargets(
  composer: HTMLElement | null,
  anchor: { x: number; y: number } | null,
  buttonSize: number,
  originVisual?: HTMLElement | null,
): boolean {
  try {
    return fxRegistry().split?.(composer, anchor, buttonSize, originVisual) ?? false;
  } catch {
    return false;
  }
}

/**
 * 分裂动画整体锁定时长（占位态多久后放开交互）。
 * ★ 与 registry.split 里“最后一颗按钮落位 + ghost 摘除”的时刻**共用同一套常量**，
 *   否则按钮会在动画中途被解成正常态（上一版两套时间轴各写各的，踩过）。
 */
export function splitTotalMs(total: number): number {
  const n = Math.max(1, total);
  return MORPH_LEAD_MS + (n - 1) * MORPH_STAGGER_MS + MORPH_MS + MORPH_HOLD_MS;
}

export function LiquidSendFxHost() {
  const rootRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  /** 按钮分裂舞台（见 .pi-morph-layer）：跟 root 同级，但 z-index 高一层 */
  const morphRef = useRef<HTMLDivElement>(null);
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
    const morphLayer = morphRef.current;
    if (!root || !overlay || !holder || !morphLayer) return;
    const D = window as unknown as Record<string, unknown>;
    D.__fxHostReady = true;

    /**
     * 每个相位独立计时——曾经共用一个 phaseTimer，导致先起的 pi-flow 的
     * “到点摘类”计时器被后起的 pi-split 清掉：pi-flow 永远留在 root 上，
     * 发送按钮那一团液体收尾后不会消失（实测 t2600 时 blob 还挂在按钮上）。
     */
    const phaseTimers = new Map<string, number>();
    /** 上一轮分裂的水珠清理函数（连发时先把上一批水珠拆干净） */
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

    /**
     * 播放一个动画相位：先摘旧类、强制回流，保证连点也能从头播。
     * 只摘同名类（不再清掉其他相位）——发送时 pi-flow（文字流）与 pi-morphing
     * 是同一帧开始的，之前把所有类一起清掉会把刚起的文字流直接抹掉。
     */
    const runPhase = (cls: "pi-flow" | "pi-chip-flow", ms: number) => {
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
     * 按钮分裂期间给根层挂 pi-morphing：只为了把「液态泵」(.pi-liquid) 压掉。
     * 泵和 ghost 里的按钮克隆抢同一格（发送钮），同时出现就是一团大蓝球裹着
     * 红环 —— 用户形容的“像涂了一层颜料”。光字层 .pi-flow-text 不受影响。
     */
    const setMorphing = (on: boolean) => {
      root.classList.toggle("pi-morphing", on);
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
      holder.style.lineHeight = cs.lineHeight;
      holder.dataset.width = String(tRect.width);
      return true;
    };

    /**
     * 逐帧驱动「发光文字向右飘出」。
     *
     * ★ 所有位移都是**相对**的：光字沿「右侧 + 波浪起伏」向外飞，
     *   不需要知道对话区气泡在哪，因此**永远不会飘错位置**。
     *
     * 运动构成（借参考 demo 的波浪参数，让“一束光”而不是“一排平移的字”）：
     *   · 横向：Dx × ease（越长越远）+ 每字递增的散开量（终点不叠成一团）
     *   · 纵向：sin 波浪（相位逐字推进，形成上下游动的光带）
     *   · 错峰：每颗延迟 i * DRIFT_STAGGER_MS，形成流水般的队列
     *   · 消散：中后段淡出 + blur 加深（文字“化掉”而不是“被切断”）
     */
    const driveFlow = (spans: HTMLElement[], startAt: number) => {
      const total = Math.max(1, spans.length);
      // 字数多时压缩错峰，避免整束光拖太久（总滞后上限 DRIFT_MAX_LAG_MS）
      const stagger = Math.min(DRIFT_STAGGER_MS, DRIFT_MAX_LAG_MS / total);
      const lastStart = stagger * total;
      const totalTime = DRIFT_MS + lastStart + 80;
      // 飘出距离：取输入框宽度的固定比例，并夹在 [DRIFT_MIN_PX, DRIFT_MAX_PX] 之间。
      // ★ 始终是**相对**距离，不依赖任何绝对坐标 —— 所以永远不会“飘错位置”。
      const boxWidth = Number(holder.dataset.width ?? 0);
      const Dx = Math.min(DRIFT_MAX_PX, Math.max(DRIFT_MIN_PX, boxWidth * DRIFT_RATIO));
      // 后字多飞一点：否则右边界对齐的文字会在终点叠成一团（demo 的 i*1.3 同义）
      const spreadFor = (i: number) => Math.min(DRIFT_SPREAD_MAX, i * DRIFT_SPREAD_PER_CHAR);
      // 纵向波浪：与 demo 完全同一套，相位沿字序推进出“流动感”
      const wavePhaseFor = (i: number) => (i / total) * Math.PI * 5;
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
            span.style.transform = "translate(0px, 0px)";
            span.style.filter = "none";
            continue;
          }
          const t = Math.min(1, local);
          const e = ease(t);
          const phase = wavePhaseFor(i);
          // 横向：主行程 + 逐字散开，早期额外冲一下（像被“抽”出去）
          const dx = Dx * e + spreadFor(i) * e + Math.sin(phase) * 12 * Math.min(1, t * 3);
          // 纵向：两端各一次大起伏，形成波浪光带
          const wave = Math.sin(phase) * 22 * Math.sin(Math.PI * Math.min(1, t * 1.1));
          const dy = wave + Math.sin(phase + 0.8) * 10 * e;
          // 尺寸：先鼓一下（被拉走）再收细
          const scale = t < 0.18 ? 1 + (t / 0.18) * 0.14 : 1.14 - ((t - 0.18) / 0.82) * 0.42;
          // 透明度：入流迅速显现 → 中后段化开消失（与 blur 同步，避免“硬切断”）
          const op = t < 0.1 ? t / 0.1 : Math.max(0, 1 - Math.pow(Math.max(0, (t - 0.35) / 0.65), 1.3));
          const blur = t < 0.4 ? 0 : ((t - 0.4) / 0.6) * 6;
          span.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(3)})`;
          span.style.opacity = String(Math.max(0, Math.min(1, op)).toFixed(3));
          span.style.filter = blur <= 0.05 ? "none" : `blur(${blur.toFixed(2)}px)`;
        }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    };

    /**
     * 让新出现的用户气泡**延迟足够久、从右侧滑入**（替代旧的“等流光汇到位”）。
     *
     * 为什么改成这样：气泡的目标位置无法在点击时可靠得知（React 异步插入 + 列表滚动），
     * 所以不再让光字去追气泡，而是反过来——**气泡自己在光字飞出去之后再从右边进来**，
     * 与光字向右飘出在时间上错开，形成“内容先出去、消息后回来”的完整叙事。
     * ★ 关键是**绝对截止时刻**（deadline）：气泡插入得早也不能提前进场，
     *   否则就成了“字还没离开输入框，消息已经出来了”。
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
      /** 绝对截止时刻：气泡无论何时被插入，都不能早于这个时间点进场 */
      const deadline = performance.now() + delayMs;
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
        el.classList.add("pi-bubble-in-right-pending");
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
          el.classList.remove("pi-bubble-in-right-pending");
          el.classList.add("pi-bubble-in-right");
          window.setTimeout(() => el.classList.remove("pi-bubble-in-right"), 660);
        });
        found.clear();
        bubbleReveal = null;
      };

      collect();
      observer = new MutationObserver(() => {
        collect();
        // 气泡一到就按**绝对截止时刻**安排入场：早到了就等够 deadline（光字先飞出去），
        // 晚到了也要再缓一下 settle，绝不与点击同帧冒出来。
        if (!revealed && found.size) {
          window.clearTimeout(startTimer);
          startTimer = window.setTimeout(
            reveal,
            Math.max(BUBBLE_SETTLE_MS, deadline - performance.now()),
          );
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

      // 气泡延迟从右侧滑入（光字先向右飘出去，气泡再进场）
      holdBubbleUntilArrival(BUBBLE_DELAY_MS);

      // 逐字生成光字（上限 MAX_FLOW_CHARS，避免一次挂太多动画节点）
      holder.textContent = "";
      const chars = [...text].slice(0, MAX_FLOW_CHARS);
      const frag = document.createDocumentFragment();
      const spans: HTMLElement[] = [];
      chars.forEach((ch) => {
        const span = document.createElement("span");
        span.className = "pi-flow-char";
        // 空白不产辉光（否则一束光里夹空洞），但仍占位保持排版一致
        span.textContent = ch === " " ? " " : ch;
        span.dataset.blank = ch === " " ? "1" : "0";
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
      if (!layoutFlow(composer, textarea, button)) return false;
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
              layoutFlow(composerNow, textareaNow, buttonNow);
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
      }, FLOW_MS + 700);

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
      const flowTotal = DRIFT_MS + DRIFT_MAX_LAG_MS;
      // 收尾等整体时长 + 一点余量再清场（与 driveFlow 的 totalTime 同量级）
      const cleanupAfter = flowTotal + 200;
      flowTimer = window.setTimeout(() => {
        holder.textContent = "";
        overlay.style.display = "none";
      }, cleanupAfter);
      if (restoreTimer) window.clearTimeout(restoreTimer);
      restoreTimer = window.setTimeout(restoreTextarea, cleanupAfter);
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
     * 发送按钮「一分三」（第七版：按钮本体形变，不再有任何液体）。
     *
     * 设计说明见文件头部 MORPH_* 常量处的长注释。要点：
     *   ① 圆钮坑位做**同位置形变**：发送按钮的真实克隆（蓝）向内化开，
     *      停止按钮的真实克隆（红）顶上来 —— 两层叠在同一个 32px 圆里，
     *      所以读作“同一个按钮在变色”，而不是“别的东西飞过来”。
     *   ② 其余按钮用 FLIP：起点位移 = 自己到圆钮中心的距离，于是它们
     *      看起来是**从按钮底下被抽出来**的（不是从别处飘过来）。
     *   ③ 全程不引入新颜色：ghost 就是真实按钮的克隆，主题一变它跟着变。
     */
    registry.split = (_composer, anchor, buttonSize, originVisual) => {
      if (prefersReducedMotion() || !anchor) return false;
      const btns = [...document.querySelectorAll<HTMLElement>("[data-pi-split]")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
      if (!btns.length) return false;

      if (splitCleanup) splitCleanup();
      const timers: number[] = [];
      const anims: Animation[] = [];

      /**
       * ── ① 圆钮坑位：优先用**当下重新量一次**「停止」按钮的位置 ──
       * ★ 不能用点击那一刻量到的 anchor：空会话发第一条消息时 ChatWindow 会切分支，
       *   composer 会整体下移（实测 y 477 → 800），拿旧坐标画出来的变色圆钮会孤零零
       *   飘在对话区中部，和真正落位的三颗按钮差 300px —— 这就是“分裂效果很怪”的主因。
       *   停止按钮是发送按钮的**同位继任者**（就在原来那个坑里），播放时刻量它才是
       *   用户眼里“同一个按钮”的位置。只有量不到时（节点没渲染出来）才退回 anchor。
       */
      const stopEl = btns.find((b) => b.dataset.piSplit === "stop") ?? null;
      const sr = stopEl?.getBoundingClientRect();
      const measured = sr && sr.width >= 16 && sr.height >= 16;
      const size = Math.max(24, Math.round((measured ? sr.width : 0) || buttonSize || 32));
      const cx = measured ? sr.left + sr.width / 2 : anchor.x;
      const cy = measured ? sr.top + sr.height / 2 : anchor.y;

      const ghost = document.createElement("div");
      ghost.className = "pi-morph-ghost";
      Object.assign(ghost.style, {
        left: `${(cx - size / 2).toFixed(1)}px`,
        top: `${(cy - size / 2).toFixed(1)}px`,
        width: `${size.toFixed(1)}px`,
        height: `${size.toFixed(1)}px`,
      });
      /**
       * 克隆体统一成“贴满 ghost 的一层”：
       * ★ 必须在 JS 里写行内样式，不能只靠 CSS 类 —— 原按钮自带**行内**
       *   width/height/padding（实测 32px + 1px 边框），CSS 类的 width:100% 压不住
       *   行内声明，克隆会胖一圈变成“红圈包蓝球”。行内赋值是同一属性声明覆盖，才是稳的。
       */
      const fitClone = (el: HTMLElement) => {
        el.classList.remove("pi-morph-pending");
        el.removeAttribute("data-pi-split"); // 克隆体不参与任何选择器/埋点
        Object.assign(el.style, {
          position: "absolute",
          left: "0",
          top: "0",
          width: "100%",
          height: "100%",
          padding: "0",
          margin: "0",
          boxSizing: "border-box",
          transformOrigin: "center",
          pointerEvents: "none",
        });
      };
      // 红的先挂（在下层）：蓝化开时正好从中间露出来
      const toVisual = stopEl ? (stopEl.cloneNode(true) as HTMLElement) : null;
      if (toVisual) {
        toVisual.className = "pi-morph-target";
        fitClone(toVisual);
        ghost.appendChild(toVisual);
      }
      if (originVisual) {
        originVisual.className = "pi-morph-origin";
        fitClone(originVisual);
        ghost.appendChild(originVisual);
      }
      const ring = document.createElement("span");
      ring.className = "pi-morph-ring";
      ghost.appendChild(ring);
      morphLayer.appendChild(ghost);

      // 圆钮整体轻吞一下 + 一圈 accent 涟漪（只借主题色，不画新色块）
      anims.push(ghost.animate([
        { transform: "scale(1)" },
        { transform: "scale(1.06)", offset: 0.3 },
        { transform: "scale(1)" },
      ], { duration: MORPH_MS, easing: "cubic-bezier(0.3, 0.7, 0.3, 1)" }));
      anims.push(ring.animate([
        { opacity: 0.38, transform: "scale(1)" },
        { opacity: 0, transform: "scale(1.45)" },
      ], { duration: 420, delay: 60, easing: "cubic-bezier(0.22, 0.9, 0.24, 1)", fill: "both" }));
      if (originVisual) {
        // 蓝：向内缩成一个小点后被“吸走”。
        // ★ fill 必须是 both：用 backwards 的话动画一结束元素就回到自身 style
        //   （opacity 1），蓝箭头会在红按钮上闪回来 —— 实测 t≈320ms 闪现。
        // ★ 必须在 红 进场前把蓝清完：两者叠加会变成紫色一大块（实测 t≈170ms）。
        anims.push(originVisual.animate([
          { opacity: 1, transform: "scale(1)", offset: 0 },
          { opacity: 0.8, transform: "scale(0.8)", offset: 0.3 },
          { opacity: 0.2, transform: "scale(0.42)", offset: 0.66 },
          { opacity: 0, transform: "scale(0.3)", offset: 1 },
        ], { duration: MORPH_CROSS_MS, easing: "cubic-bezier(0.4, 0, 0.25, 1)", fill: "both" }));
      }
      if (toVisual) {
        // 红：等蓝彻底退干净（delay = MORPH_TARGET_DELAY_MS >= MORPH_CROSS_MS）才现身，
        // 只做一小段 scale 落位（0.9 → 1）。
        // ★ 不用“从 0.5 放大到 1”：那是往圆钮里塞一个会胀大的球，观感就是“一团球”。
        // ★ 叠放顺序是 红在下、蓝在上（先 append 红），重叠期的少量叠加色也是蓝压红，
        //   不会混出紫色。
        anims.push(toVisual.animate([
          { opacity: 0, transform: "scale(0.9)" },
          { opacity: 1, transform: "scale(1.03)", offset: 0.7 },
          { opacity: 1, transform: "scale(1)" },
        ], {
          duration: MORPH_TARGET_MS,
          delay: MORPH_TARGET_DELAY_MS,
          easing: "cubic-bezier(0.22, 0.9, 0.24, 1)",
          fill: "both",
        }));
      }

      /* ── ② 其余按钮：离圆钮近的先被抽出来（队列感来自距离）── */
      const ordered = btns
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { el, r, d: Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy) };
        })
        .sort((a, b) => a.d - b.d);

      ordered.forEach(({ el, r }, i) => {
        // ★ 起点：把按钮“收缩回圆钮里”。用 transform-origin: right center，
        //   位移取「自己的右缘 → 圆钮中心」，缩到 0.5 时它就是一个趴在圆钮上的小胶囊，
        //   然后右缘归位 + 放大到 1 → 读作「从按钮底下被抽出来」，且因为一路都小，
        //   错峰时两个胶囊的文字重叠面积远小于整宽平移（实测那种写法会糊成重影）。
        const dx = cx - r.right;
        const dy = cy - (r.top + r.height / 2);
        const delay = MORPH_LEAD_MS + i * MORPH_STAGGER_MS;
        // 摘掉 React 给的占位类（opacity:0）——下面 WAAPI 的 backwards fill
        // 会在延迟期间继续提供 opacity:0，所以不会闪一下
        el.classList.remove("pi-morph-pending");
        el.style.opacity = "";
        el.style.animationDelay = "";
        el.style.transformOrigin = "right center";
        anims.push(el.animate([
          // ★ 飞行前半程**保持不可见**：三颗都从圆钮出发，若一出发就 opacity 1，
          //   它们会在同一片区域重叠成重影（实测 t≈240ms「引导」与「后续消息」叠字）。
          //   先隐形飞过大半，再在自己坑位附近凝出 → 只读作“一颗一颗长出来”。
          { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(0.5)`, opacity: 0, offset: 0 },
          { transform: `translate(${(dx * 0.34).toFixed(1)}px, ${(dy * 0.34).toFixed(1)}px) scale(0.68)`, opacity: 0, offset: 0.36 },
          { transform: `translate(${(dx * 0.08).toFixed(1)}px, ${(dy * 0.08).toFixed(1)}px) scale(0.94)`, opacity: 1, offset: 0.62 },
          { transform: "translate(-1.2px, 0px) scale(1.012)", opacity: 1, offset: 0.86 },
          { transform: "translate(0px, 0px) scale(1)", opacity: 1, offset: 1 },
        ], {
          duration: MORPH_MS,
          delay,
          // 快出慢入，末端一点回弹：读作被“抽”出来然后卡进位
          easing: "cubic-bezier(0.22, 0.9, 0.24, 1)",
          fill: "backwards",
        }));
      });

      const total = MORPH_LEAD_MS + (ordered.length - 1) * MORPH_STAGGER_MS + MORPH_MS + MORPH_HOLD_MS;
      const cleanup = () => {
        anims.forEach((a) => { try { a.cancel(); } catch { /* 动画已随节点移除，忽略 */ } });
        ghost.remove();
        setMorphing(false);
        // 把可能残留的行内占位抹掉：React 在流式期间重渲染会重新写回
        // opacity:0（flushSplit 仍为 true），不抹就会“动画跑完按钮还隐着”。
        ordered.forEach(({ el }) => {
          el.style.opacity = "";
          el.style.transformOrigin = "";
          el.classList.remove("pi-morph-pending");
        });
        timers.forEach((id) => window.clearTimeout(id));
        splitCleanup = null;
      };
      splitCleanup = cleanup;
      setMorphing(true);
      timers.push(window.setTimeout(cleanup, total));
      return true;
    };

    return () => {
      registry.play = undefined;
      registry.absorb = undefined;
      registry.split = undefined;
      if (splitCleanup) splitCleanup();
      if (bubbleReveal) bubbleReveal();
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
        <span className="pi-liquid-tail" />
        <span className="pi-liquid-drop-b" />
        <span className="pi-liquid-drop-a" />
        <span className="pi-liquid-main" />
        <span className="pi-liquid-ghost" />
        <span className="pi-liquid-chip" />
      </div>
      {/* 水珠流：**不放进 .pi-liquid**。水珠各自带高光/投影，进 goo 滤镜会被模糊
          成一团色块（滤镜会把每个水球的细节融掉）；放无滤镜的根层反而球体更清晰。
          它们的“汇合成流”感由逐字错峰飞行 + 沿路径的浮沉曲线给出。 */}
      <div className="pi-liquid-wave" />
      <div className="pi-flow-text" ref={overlayRef}>
        <div ref={holderRef} />
      </div>
      {/* 按钮分裂舞台：装的是真实按钮的克隆（见 registry.split），不放任何自画色块 */}
      <div className="pi-morph-layer" ref={morphRef} />
    </div>,
    document.body,
  );
}
