"use client";

/**
 * GlowBackground — switchable DeepSeek-style dynamic background.
 *
 * Layers:
 *  ① CSS 模糊光斑层（3 团 radial-gradient + blur，底部左/中/右分布）——强度可由用户拖动调节
 *  ② Canvas2D 动态效果层，可选样式（设置里切换）：
 *       - particles  粒子连线网络（距离近则连线，鼠标 hover 轻推）
 *       - planets    轨道行星系（椭圆轨道 + 光晕 + 星空背景 + 鼠标视差）
 *       - aurora     流动极光带（多层正弦光带 + 渐变）
 *       - stars      星空（闪烁星点）
 *
 * 关键点：
 *  - 颜色全部用 CSS 变量派生（var(--accent)/var(--text-dim)），亮暗自动适配。
 *  - position:fixed; inset:0; zIndex:1; pointerEvents:none —— 浮在内容面板之上、
 *    不拦截任何指针事件。
 *  - 用户通过设置开关显式开启，故始终带动画 + 鼠标响应（用户明确选择优先于系统
 *    prefers-reduced-motion）。
 *  - 性能：~30fps、视口自适应、隐藏标签页 rAF 自动暂停。
 */
import { useEffect, useRef } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useGlowBackground, type GlowStyle } from "@/hooks/useGlowBackground";

/* ── 类型 ─────────────────────────────────────────────────────────────── */

interface Particle { x: number; y: number; vx: number; vy: number; r: number }
interface Planet {
  radius: number; size: number; speed: number;
  angle: number; tone: number; // 0..1 → 向白亮度偏移
  moon?: { dist: number; size: number; speed: number; angle: number };
}
interface Star { x: number; y: number; r: number; phase: number; speed: number; base: number }
interface BokehOrb { x: number; y: number; r: number; vx: number; vy: number; tone: number }
interface NebulaBlob { x: number; y: number; r: number; vx: number; vy: number; a: number }
type Rgb = [number, number, number];

const LINK_DIST = 140;      // 粒子连线最大距离
const FPS_CAP = 30;
const BASE_COUNT = 60;      // 基础粒子数（视口自适应）
const STAR_BASE = 90;       // 星空基础星数

/* ── 光斑基础透明度（intensity 会额外乘上去） ─────────────────────────── */
const BLOB_BASE = [
  { dark: 0.5, light: 0.42 },
  { dark: 0.55, light: 0.45 },
  { dark: 0.45, light: 0.38 },
];

/* ── 颜色辅助 ─────────────────────────────────────────────────────────── */

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 把 rgb 按 factor（0..1）向白色偏移（factor=0 → 原色）。 */
function lighten(rgb: Rgb, factor: number): Rgb {
  return [
    Math.round(rgb[0] + (255 - rgb[0]) * factor),
    Math.round(rgb[1] + (255 - rgb[1]) * factor),
    Math.round(rgb[2] + (255 - rgb[2]) * factor),
  ];
}

function rgba(rgb: Rgb, a: number): string {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${clamp(a, 0, 1)})`;
}

/* ── 各样式状态生成 ───────────────────────────────────────────────────── */

function spawnParticles(w: number, h: number): Particle[] {
  const area = w * h;
  const target = Math.min(Math.max(Math.round(BASE_COUNT * (area / (1280 * 800))), 40), 180);
  const out: Particle[] = [];
  for (let i = 0; i < target; i++) {
    out.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      r: Math.random() < 0.5 ? 1.2 : (Math.random() * 1.6 + 1.4),
    });
  }
  return out;
}

function spawnPlanets(w: number, h: number): Planet[] {
  const base = Math.min(w, h);
  return [
    { radius: base * 0.09, size: 8,  speed: 0.34,  angle: Math.random() * 6.28, tone: 0.05 },
    { radius: base * 0.16, size: 13, speed: -0.20, angle: Math.random() * 6.28, tone: 0.22, moon: { dist: 22, size: 3.2, speed: 1.6, angle: 0 } },
    { radius: base * 0.24, size: 9,  speed: 0.12,  angle: Math.random() * 6.28, tone: 0.4 },
    { radius: base * 0.34, size: 5,  speed: -0.08, angle: Math.random() * 6.28, tone: 0.55 },
  ];
}

function spawnStars(w: number, h: number): Star[] {
  const count = Math.min(Math.max(Math.round(STAR_BASE * (w * h) / (1280 * 800)), 40), 200);
  const out: Star[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() < 0.85 ? Math.random() * 1.1 + 0.4 : Math.random() * 1.7 + 1.2,
      phase: Math.random() * 6.28,
      speed: 0.4 + Math.random() * 1.2,
      base: 0.2 + Math.random() * 0.5,
    });
  }
  return out;
}

function spawnBokeh(w: number, h: number): BokehOrb[] {
  const count = Math.min(Math.max(Math.round(24 * (w * h) / (1280 * 800)), 14), 34);
  const out: BokehOrb[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 22 + Math.random() * 68,
      vx: (Math.random() - 0.5) * 0.35,
      vy: -0.18 - Math.random() * 0.5, // 缓慢上浮，覆盖全屏
      tone: Math.random(),
    });
  }
  return out;
}

function spawnNebula(w: number, h: number): NebulaBlob[] {
  const out: NebulaBlob[] = [];
  const count = 10;
  for (let i = 0; i < count; i++) {
    out.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: w * 0.18 + Math.random() * w * 0.18,
      vx: (Math.random() - 0.5) * 0.12,
      vy: (Math.random() - 0.5) * 0.09,
      a: 0.05 + Math.random() * 0.06,
    });
  }
  return out;
}

/* ── 绘制各样式 ───────────────────────────────────────────────────────── */

function drawParticles(
  ctx: CanvasRenderingContext2D, w: number, h: number, particles: Particle[],
  mouseX: number, mouseY: number, dark: boolean, accent: Rgb, dim: Rgb, intensity: number,
) {
  // 连线
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    for (let j = i + 1; j < particles.length; j++) {
      const q = particles[j];
      const dx = p.x - q.x, dy = p.y - q.y;
      const dist = dx * dx + dy * dy;
      if (dist > LINK_DIST * LINK_DIST) continue;
      const alpha = (1 - dist / (LINK_DIST * LINK_DIST)) * 0.28 * intensity;
      ctx.strokeStyle = dark ? rgba(accent, alpha * 0.9) : rgba(dim, alpha);
      ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
  }
  // 粒子 + 移动 + 鼠标扰动
  for (const p of particles) {
    ctx.fillStyle = dark ? rgba(accent, 0.75 * intensity) : rgba(dim, 0.55 * intensity);
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    p.x += p.vx; p.y += p.vy;
    if (mouseX > -9999) {
      const dx = p.x - mouseX, dy = p.y - mouseY;
      const d2 = dx * dx + dy * dy;
      if (d2 < 120 * 120) {
        const d = Math.sqrt(d2) || 1;
        p.x += (dx / d) * 0.6; p.y += (dy / d) * 0.6;
      }
    }
    if (p.x < 0) p.x = w; else if (p.x > w) p.x = 0;
    if (p.y < 0) p.y = h; else if (p.y > h) p.y = 0;
  }
}

function drawStarsLayer(
  ctx: CanvasRenderingContext2D, w: number, h: number, stars: Star[],
  dark: boolean, accent: Rgb, dim: Rgb, intensity: number, t: number, boost = 1,
) {
  for (const s of stars) {
    const tw = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
    const a = (s.base + tw * 0.4) * intensity * boost;
    ctx.fillStyle = dark ? rgba(accent, a) : rgba(dim, a);
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  }
}

function drawPlanets(
  ctx: CanvasRenderingContext2D, w: number, h: number, planets: Planet[],
  mouseX: number, mouseY: number, dark: boolean, accent: Rgb, intensity: number, t: number, dt: number,
) {
  const cx = w * 0.5 + (mouseX > -9999 ? (mouseX - w / 2) * 0.02 : 0);
  const cy = h * 0.86 + (mouseY > -9999 ? (mouseY - h * 0.86) * 0.02 : 0);
  const squash = 0.4;
  const glow = clamp(0.45 * intensity, 0, 0.7);

  // 轨道
  for (const p of planets) {
    ctx.strokeStyle = rgba(accent, 0.06 * intensity);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx, cy, p.radius, p.radius * squash, 0, 0, Math.PI * 2); ctx.stroke();
  }

  for (const p of planets) {
    p.angle += p.speed * dt;
    const x = cx + Math.cos(p.angle) * p.radius;
    const y = cy + Math.sin(p.angle) * p.radius * squash;
    const z = 0.72 + 0.28 * (1 - Math.abs(Math.sin(p.angle))); // 深度缩放
    const size = p.size * z;
    const color = lighten(accent, p.tone);

    // 光晕
    const grad = ctx.createRadialGradient(x, y, 0, x, y, size * 3.2);
    grad.addColorStop(0, rgba(color, glow));
    grad.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, size * 3.2, 0, Math.PI * 2); ctx.fill();

    // 天体
    ctx.fillStyle = rgba(color, 0.95);
    ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
    // 高光
    ctx.fillStyle = `rgba(255,255,255,${0.2 * intensity})`;
    ctx.beginPath(); ctx.arc(x - size * 0.3, y - size * 0.3, size * 0.34, 0, Math.PI * 2); ctx.fill();

    // 卫星
    if (p.moon) {
      p.moon.angle += p.moon.speed * dt;
      const mx = x + Math.cos(p.moon.angle) * p.moon.dist;
      const my = y + Math.sin(p.moon.angle) * p.moon.dist;
      ctx.fillStyle = rgba(lighten(accent, 0.6), 0.9);
      ctx.beginPath(); ctx.arc(mx, my, p.moon.size, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function drawAurora(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  dark: boolean, accent: Rgb, intensity: number, t: number,
) {
  const layers = 4;
  for (let li = 0; li < layers; li++) {
    const speed = 0.25 + li * 0.11;
    const amp = 36 + li * 12;
    const baseY = h * (0.42 + li * 0.075);
    const alpha = (0.08 + li * 0.02) * intensity;
    const color = lighten(accent, li * 0.06);

    ctx.beginPath();
    ctx.moveTo(-24, baseY);
    for (let x = -24; x <= w + 24; x += 8) {
      const y = baseY + Math.sin(x * 0.006 + t * speed + li) * amp * Math.sin(t * 0.18 + li * 0.5);
      ctx.lineTo(x, y);
    }
    for (let x = w + 24; x >= -24; x -= 8) {
      const y = baseY + 30 + Math.sin(x * 0.006 + t * speed + li + 0.7) * amp * 0.55;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, baseY - amp, 0, baseY + amp + 50);
    grad.addColorStop(0, rgba(color, alpha));
    grad.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = grad;
    ctx.fill();
  }
}

function drawBokeh(
  ctx: CanvasRenderingContext2D, w: number, h: number, bokeh: BokehOrb[],
  accent: Rgb, intensity: number,
) {
  for (const b of bokeh) {
    b.x += b.vx; b.y += b.vy;
    if (b.y < -b.r) { b.y = h + b.r; b.x = Math.random() * w; }
    if (b.x < -b.r) b.x = w + b.r; else if (b.x > w + b.r) b.x = -b.r;
    const alpha = (0.05 + (b.r / 1400) + b.tone * 0.02) * intensity;
    const color = lighten(accent, 0.12 + b.tone * 0.25);
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
    g.addColorStop(0, rgba(color, alpha));
    g.addColorStop(0.55, rgba(color, alpha * 0.5));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
  }
}

function drawWaves(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  accent: Rgb, intensity: number, t: number,
) {
  const layers = 4;
  for (let li = 0; li < layers; li++) {
    const baseY = h * (0.24 + li * 0.17);
    const amp = 26 + li * 9;
    const speed = 0.6 + li * 0.12;
    const color = lighten(accent, li * 0.05);
    ctx.beginPath();
    ctx.moveTo(-24, h + 20);
    for (let x = -24; x <= w + 24; x += 10) {
      const y = baseY + Math.sin(x * 0.0075 + t * speed + li * 1.4) * amp;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w + 24, h + 20);
    ctx.closePath();
    ctx.fillStyle = rgba(color, (0.05 + li * 0.016) * intensity);
    ctx.fill();
  }
}

function drawNebula(
  ctx: CanvasRenderingContext2D, w: number, h: number, nebula: NebulaBlob[],
  accent: Rgb, intensity: number,
) {
  for (const b of nebula) {
    b.x += b.vx; b.y += b.vy;
    if (b.x < -b.r) b.x = w + b.r; else if (b.x > w + b.r) b.x = -b.r;
    if (b.y < -b.r) b.y = h + b.r; else if (b.y > h + b.r) b.y = -b.r;
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
    g.addColorStop(0, rgba(lighten(accent, 0.12), b.a * intensity));
    g.addColorStop(0.6, rgba(accent, b.a * 0.5 * intensity));
    g.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = g;
    ctx.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
  }
}

/* ── 组件 ─────────────────────────────────────────────────────────────── */

export function GlowBackground() {
  const { isDark } = useTheme();
  const { enabled, style, intensity } = useGlowBackground();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // refs so intensity/theme change doesn't recreate the canvas effect state
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;
  const styleRef = useRef<GlowStyle>(style);
  styleRef.current = style;

  useEffect(() => {
    if (!enabled) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rafId = 0;
    let width = window.innerWidth;
    let height = window.innerHeight;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    // effect state (per current style)
    let particles: Particle[] = [];
    let planets: Planet[] = [];
    let stars: Star[] = [];
    let bokeh: BokehOrb[] = [];
    let nebula: NebulaBlob[] = [];
    let styleNow = styleRef.current;

    const initCanvas = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const spawnAll = () => {
      styleNow = styleRef.current;
      particles = spawnParticles(width, height);
      planets = spawnPlanets(width, height);
      stars = spawnStars(width, height);
      bokeh = spawnBokeh(width, height);
      nebula = spawnNebula(width, height);
    };

    const onResize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      initCanvas();
      spawnAll();
    };

    initCanvas();
    spawnAll();

    // 把 CSS 变量/hex 解析为 [r,g,b]。
    const parseColor = (css: string): Rgb => {
      const tmp = document.createElement("div");
      tmp.style.color = css;
      tmp.style.display = "none";
      document.body.appendChild(tmp);
      const rgb = getComputedStyle(tmp).color;
      document.body.removeChild(tmp);
      const m = rgb.match(/\d+/g)?.slice(0, 3).map(Number);
      if (m && m.length === 3) return [m[0], m[1], m[2]];
      return [91, 175, 104];
    };

    const accent = parseColor("var(--accent)");
    const dim = parseColor("var(--text-dim)");

    let last = 0;
    let lastFrame = performance.now();
    let frame = 0;
    const mouse = { x: -9999, y: -9999, active: false };

    const draw = (now: number) => {
      rafId = requestAnimationFrame(draw);
      if (now - last < 1000 / FPS_CAP) return;
      const dt = Math.min((now - lastFrame) / 1000, 0.05);
      lastFrame = now;
      last = now;
      frame++;
      if (frame % 120 === 0) {
        const na = parseColor("var(--accent)");
        const nd = parseColor("var(--text-dim)");
        accent[0] = na[0]; accent[1] = na[1]; accent[2] = na[2];
        dim[0] = nd[0]; dim[1] = nd[1]; dim[2] = nd[2];
      }
      // 若样式在运行中被切换，惰性重建对应状态
      if (styleRef.current !== styleNow) {
        styleNow = styleRef.current;
        spawnAll();
      }

      const dark = isDarkRef.current;
      const intens = intensityRef.current;
      const t = now / 1000;
      const s = styleNow;

      ctx.clearRect(0, 0, width, height);

      if (s === "particles") {
        drawParticles(ctx, width, height, particles, mouse.x, mouse.y, dark, accent, dim, intens);
      } else if (s === "planets") {
        drawStarsLayer(ctx, width, height, stars, dark, accent, dim, intens * 0.9, t, 0.7);
        drawPlanets(ctx, width, height, planets, mouse.x, mouse.y, dark, accent, intens, t, dt);
      } else if (s === "aurora") {
        drawStarsLayer(ctx, width, height, stars, dark, accent, dim, intens * 0.7, t, 0.6);
        drawAurora(ctx, width, height, dark, accent, intens, t);
      } else if (s === "bokeh") {
        drawBokeh(ctx, width, height, bokeh, accent, intens);
      } else if (s === "waves") {
        drawStarsLayer(ctx, width, height, stars, dark, accent, dim, intens * 0.5, t, 0.5);
        drawWaves(ctx, width, height, accent, intens, t);
      } else if (s === "nebula") {
        drawNebula(ctx, width, height, nebula, accent, intens);
      } else { // stars
        drawStarsLayer(ctx, width, height, stars, dark, accent, dim, intens, t, 1);
      }
    };

    const onMouse = (e: MouseEvent) => {
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true;
    };
    const onMouseLeave = () => {
      mouse.x = -9999; mouse.y = -9999; mouse.active = false;
    };

    window.addEventListener("mousemove", onMouse, { passive: true });
    document.addEventListener("mouseleave", onMouseLeave);
    const ro = new ResizeObserver(onResize);
    ro.observe(document.body);

    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("mousemove", onMouse);
      document.removeEventListener("mouseleave", onMouseLeave);
      ro.disconnect();
    };
  }, [enabled]);

  if (!enabled) return null;

  const blobOpacity = (idx: number) => {
    const base = isDark ? BLOB_BASE[idx].dark : BLOB_BASE[idx].light;
    return clamp(base * intensity, 0, 0.9);
  };

  return (
    <>
    <style>{`
      /* 动态背景光斑：自由飘动（与 translate 居中属性叠加，GPU 合成） */
      .glow-blob {
        will-change: transform;
        transform: translateZ(0);
      }
      @keyframes glow-drift-a {
        0%, 100% { transform: translate(0px, 0px) scale(1); }
        25%      { transform: translate(72px, -46px) scale(1.1); }
        55%      { transform: translate(-52px, -72px) scale(0.92); }
        80%      { transform: translate(56px, -26px) scale(1.05); }
      }
      @keyframes glow-drift-b {
        0%, 100% { transform: translate(0px, 0px) scale(1); }
        30%      { transform: translate(-82px, -36px) scale(1.13); }
        70%      { transform: translate(66px, -56px) scale(0.9); }
      }
      @keyframes glow-drift-c {
        0%, 100% { transform: translate(0px, 0px) scale(1); }
        40%      { transform: translate(-62px, -52px) scale(1.1); }
        75%      { transform: translate(52px, -30px) scale(0.94); }
      }
      .glow-blob-left   { animation: glow-drift-a 9s ease-in-out infinite; }
      .glow-blob-center { animation: glow-drift-b 13s ease-in-out infinite; }
      .glow-blob-right  { animation: glow-drift-c 11s ease-in-out infinite; }
    `}</style>
    <div
      aria-hidden="true"
      className="glow-background"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      <div
        className="glow-blob glow-blob-left"
        style={{
          position: "absolute",
          bottom: "-100px",
          left: "8%",
          width: "480px",
          height: "480px",
          opacity: blobOpacity(0),
          background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 62%, transparent) 0%, transparent 72%)",
          filter: "blur(48px)",
          borderRadius: "50%",
        }}
      />
      <div
        className="glow-blob glow-blob-center"
        style={{
          position: "absolute",
          bottom: "-60px",
          left: "50%",
          translate: "-50% 0",
          width: "700px",
          height: "400px",
          opacity: blobOpacity(1),
          background: "radial-gradient(ellipse, color-mix(in srgb, var(--accent) 58%, transparent) 0%, color-mix(in srgb, var(--accent) 34%, transparent) 42%, transparent 74%)",
          filter: "blur(58px)",
        }}
      />
      <div
        className="glow-blob glow-blob-right"
        style={{
          position: "absolute",
          bottom: "-80px",
          right: "8%",
          width: "400px",
          height: "400px",
          opacity: blobOpacity(2),
          background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 58%, transparent) 0%, color-mix(in srgb, var(--accent) 30%, transparent) 32%, transparent 72%)",
          filter: "blur(42px)",
          borderRadius: "50%",
        }}
      />
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          background: "transparent",
        }}
      />
    </div>
    </>
  );
}
