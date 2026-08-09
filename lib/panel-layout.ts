export const MOBILE_MAX_WIDTH = 640;
export const SPLIT_PANEL_MIN_WIDTH = 960;

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

export const RIGHT_PANEL_FALLBACK_WIDTH = 560;
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_MAX_WIDTH = 1200;

// Safety ceiling for the resizable right panel — the real limit is computed
// from the viewport (getRightPanelMaxWidth); 4096 only keeps 4K+ monitors from
// ever hitting the cap.
export const RIGHT_PANEL_ABSOLUTE_MAX_WIDTH = 4096;

const COMPACT_CHAT_MIN_WIDTH = 320;
const DESKTOP_CHAT_MIN_WIDTH = 320;

// When the file panel is dragged to its widest, the chat column keeps only
// this slim sliver (still enough to keep the separator grabbable). For a
// truly full-screen view use the panel's maximize button instead.
export const DRAGGED_CHAT_MIN_WIDTH = 120;

export function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  const finiteWidth = Number.isFinite(width) ? width : minWidth;
  const effectiveMax = Math.max(minWidth, maxWidth);
  return Math.round(Math.max(minWidth, Math.min(effectiveMax, finiteWidth)));
}

export function getDefaultRightPanelWidth(viewportWidth: number): number {
  return clampPanelWidth(viewportWidth * 0.42, 360, 640);
}

export function getSidebarMaxWidth(options: {
  viewportWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
}): number {
  const { viewportWidth, rightPanelOpen, rightPanelWidth } = options;
  if (viewportWidth <= MOBILE_MAX_WIDTH) return SIDEBAR_MAX_WIDTH;

  const compact = viewportWidth < SPLIT_PANEL_MIN_WIDTH;
  const chatWidth = compact ? COMPACT_CHAT_MIN_WIDTH : DESKTOP_CHAT_MIN_WIDTH;
  const visibleRightPanelWidth = !compact && rightPanelOpen ? rightPanelWidth : 0;
  return Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - chatWidth - visibleRightPanelWidth);
}

export function getRightPanelMaxWidth(options: {
  viewportWidth: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
}): number {
  const { viewportWidth, sidebarOpen, sidebarWidth } = options;
  if (viewportWidth < SPLIT_PANEL_MIN_WIDTH) return RIGHT_PANEL_MAX_WIDTH;

  const visibleSidebarWidth = sidebarOpen ? sidebarWidth : 0;
  return Math.max(
    RIGHT_PANEL_MIN_WIDTH,
    viewportWidth - DRAGGED_CHAT_MIN_WIDTH - visibleSidebarWidth,
  );
}
