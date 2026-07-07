// Row virtualization math for the library table. Fixed row height (a
// density choice, not a per-row measurement), so the visible slice is
// pure arithmetic — the table renders only [start, end) and pads the
// rest with two spacer rows so the scrollbar reflects the full list.

export interface WindowInput {
  /** Scroll offset of the container, in px. */
  scrollTop: number;
  /** Visible height of the scroll container, in px. */
  viewport: number;
  /** Uniform rendered height of one row, in px. */
  rowHeight: number;
  /** Total rows in the (already sorted/filtered) list. */
  total: number;
  /** Extra rows kept above and below the viewport to hide scroll seams. */
  overscan: number;
}

export interface RowWindow {
  /** First rendered row index (inclusive). */
  start: number;
  /** One past the last rendered row index (exclusive). */
  end: number;
  /** Spacer height standing in for rows above `start`, in px. */
  padTop: number;
  /** Spacer height standing in for rows below `end`, in px. */
  padBottom: number;
}

/**
 * New scrollTop that brings row `index` fully into view, or null when
 * it is already visible (so callers skip a no-op scroll that would
 * fight click selection). `headroom` is the sticky-header height that
 * covers the top of the scroll container.
 */
export function revealOffset(args: {
  index: number;
  scrollTop: number;
  viewport: number;
  rowHeight: number;
  headroom: number;
}): number | null {
  const { index, scrollTop, viewport, rowHeight, headroom } = args;
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  const viewTop = scrollTop + headroom;
  const viewBottom = scrollTop + viewport;
  if (top < viewTop) return Math.max(0, top - headroom);
  if (bottom > viewBottom) return bottom - viewport;
  return null;
}

export function rowWindow({ scrollTop, viewport, rowHeight, total, overscan }: WindowInput): RowWindow {
  if (total <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  }
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.ceil(viewport / rowHeight);
  const start = Math.max(0, Math.min(firstVisible - overscan, total));
  const end = Math.min(total, firstVisible + visibleCount + overscan);
  return {
    start,
    end: Math.max(start, end),
    padTop: start * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight),
  };
}
