/**
 * Resolve the OS-level target for a generated file.
 *
 * pi-studio's native right-panel viewer opens .univer files (worktrees,
 * writeback-aware). But "open externally" / "reveal in folder" actions target
 * the deliverable the user actually double-clicks — for a .univer that was
 * written back to its original .xlsx, that is the sibling .xlsx (same basename).
 *
 * Returns the .xlsx sibling when the input is a .univer; otherwise the input
 * unchanged. Callers must still verify existence + allowed roots before use.
 */
export function resolveExternalFileTarget(filePath: string): string {
  const normalized = filePath.trim();
  if (normalized.toLowerCase().endsWith(".univer")) {
    return `${normalized.slice(0, -7)}.xlsx`;
  }
  return normalized;
}
