/**
 * ExpandCanvasOverlay —— 展开大画布的可拖动、可缩放浮层。
 *  - 内部复用通用 DraggableResizableModal：顶栏整条可拖动移动；四周/四角把手可拉大缩小。
 *  - 通过 createPortal 挂 <body>：暗色蒙版覆盖一切（含最左侧一级导航等侧栏）。
 *  - 顶栏：标题 + 提示 + 「✕ 退出」；内容区放 WorkflowEditor（height="100%"）。
 *  - 用法：点 WorkflowEditor 顶栏「⛶ 全屏」→ onExpand → 渲染本组件包裹大画布。
 */
"use client";

import type { ReactNode } from "react";
import { DraggableResizableModal } from "./DraggableResizableModal";

export function ExpandCanvasOverlay({
  title = "🧩 工作流画布",
  hint = "拖节点移动 · 拖右侧圆点连线 · 双击边/节点编辑 · Delete 删除",
  onClose,
  children,
}: {
  title?: string;
  hint?: string;
  onClose: () => void;
  /** 大画布（WorkflowEditor，height="100%"） */
  children: ReactNode;
}) {
  return (
    <DraggableResizableModal
      title={title}
      hint={`${hint} — ↕ 顶栏可拖动 · 边缘/四角可缩放`}
      onClose={onClose}
      width="76vw"
      height="60vh"
    >
      {children}
    </DraggableResizableModal>
  );
}