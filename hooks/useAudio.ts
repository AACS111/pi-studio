"use client";

import { useState, useRef, useCallback, useEffect } from "react";

function playTone(ctx: AudioContext) {
  const now = ctx.currentTime;
  const freqs = [523.25, 659.25];
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    const t = now + i * 0.18;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.start(t);
    osc.stop(t + 0.45);
  });
}

export function useAudio() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("pi-sound-enabled");
    return stored === null ? true : stored === "true";
  });

  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // Reuse a single AudioContext so it can be resumed if the browser
  // autoplay policy suspends it (contexts created outside user gestures
  // start in "suspended" state and produce no sound).
  const ctxRef = useRef<AudioContext | null>(null);
  const getCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current && ctxRef.current.state !== "closed") return ctxRef.current;
    try {
      ctxRef.current = new AudioContext();
    } catch {
      return null;
    }
    return ctxRef.current;
  }, []);

  /**
   * 预热 AudioContext。new AudioContext() 实测要 350~1000ms（Windows/Chromium，
   * 首次创建要初始化音频线程），**不能放在点击发送的同一个回调里**——
   * 那会让「点发送」这一帧直接掉到 1s 级长任务，肉眼就是发送卡一下。
   * 这里在用户第一次 pointerdown（仍是合法 user gesture，允许 resume）或首次 idle
   * 时提前建好，点发送时 getCtx 只做一次状态判断，同步开销为 0。
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    let done = false;
    const warm = () => {
      if (done) return;
      done = true;
      const ctx = getCtx();
      if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    };
    window.addEventListener("pointerdown", warm, { once: true, capture: true });
    window.addEventListener("keydown", warm, { once: true, capture: true });
    const idle = window.setTimeout(warm, 1200);
    return () => {
      window.clearTimeout(idle);
      window.removeEventListener("pointerdown", warm, { capture: true });
      window.removeEventListener("keydown", warm, { capture: true });
    };
  }, [getCtx]);

  const unlockAudio = useCallback((force = false) => {
    if (!force && !enabledRef.current) return;
    const ctx = getCtx();
    if (!ctx || ctx.state !== "suspended") return;
    ctx.resume().catch(() => {});
  }, [getCtx]);

  const toggle = useCallback(() => {
    const next = !enabledRef.current;
    if (next) unlockAudio(true);
    enabledRef.current = next;
    localStorage.setItem("pi-sound-enabled", String(next));
    setEnabled(next);
  }, [unlockAudio]);

  const playDone = useCallback(() => {
    if (!enabledRef.current) return;
    const ctx = getCtx();
    if (!ctx) return;
    const play = () => {
      try {
        playTone(ctx);
      } catch {
        // AudioContext not available
      }
    };
    if (ctx.state === "suspended") {
      ctx.resume().then(play).catch(() => {});
      return;
    }
    play();
  }, [getCtx]);

  return { soundEnabled: enabled, onSoundToggle: toggle, playDoneSound: playDone, unlockAudio, soundEnabledRef: enabledRef };
}
