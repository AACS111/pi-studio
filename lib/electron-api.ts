/**
 * 桌面端（Electron preload 注入）能力检测。
 *
 * 纯函数工具（不含 React），客户端/服务端均可导入：
 * SSR 与首次 hydration 阶段一定返回 undefined，接入方必须在 useEffect 之后再读，
 * 否则会产生 hydration mismatch（服务端无 window.piElectron、客户端有）。
 */

export interface PiElectronWindowApi {
  minimize?: () => void;
  toggleMaximize?: () => Promise<boolean>;
  close?: () => void;
  isMaximized?: () => Promise<boolean>;
  onMaximizedChange?: (listener: (maximized: boolean) => void) => () => void;
  /** 自绘窗口缩放：按下把手时确定方位（n/s/e/w/ne/nw/se/sw）。 */
  beginResize?: (dir: string) => void;
  /** 拖动中逐帧调用，主进程按真实光标位置重算窗口 bounds。 */
  moveResize?: () => void;
  /** 松开时结束缩放。 */
  endResize?: () => void;
}

export interface PiElectronApi {
  isElectron?: boolean;
  window?: PiElectronWindowApi;
  [key: string]: unknown;
}

export function getElectronApi(): PiElectronApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { piElectron?: PiElectronApi }).piElectron;
}
