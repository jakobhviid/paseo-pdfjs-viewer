/**
 * Page geometry for the iOS panel, in unzoomed content points: pages fill the view's width and
 * stack with a gap. The scroll view's zoom scales all of it, so a position kept in these units
 * survives zooming and, as a page plus a fraction of it, rebuilds that change page sizes.
 */
export const PAGE_GAP = 8;
/** Pages rendered beyond the visible ones in each direction. */
export const OVERSCAN = 1;
/** Rendered pages kept beyond the visible ones in each direction before their images are dropped. */
export const KEEP = 4;
export const MAX_RENDER_WIDTH = 4096;
export const MAX_ZOOM = 4;

export interface PageSize {
  width: number;
  height: number;
}

export interface PageBox {
  top: number;
  height: number;
}

export interface PageLayout {
  boxes: PageBox[];
  height: number;
}

export function layoutPages(pages: readonly PageSize[], viewWidth: number): PageLayout {
  const boxes: PageBox[] = [];
  let top = 0;
  for (const page of pages) {
    const height = page.width > 0 ? (viewWidth * page.height) / page.width : viewWidth;
    boxes.push({ top, height });
    top += height + PAGE_GAP;
  }
  return { boxes, height: Math.max(0, top - PAGE_GAP) };
}

/** The last page whose top is at or above `y`, or 0. */
export function pageAt(boxes: readonly PageBox[], y: number): number {
  let low = 0;
  let high = boxes.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (boxes[middle].top <= y) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** Pages overlapping [top, bottom], widened by OVERSCAN; null without pages. */
export function visibleRange(
  boxes: readonly PageBox[],
  top: number,
  bottom: number,
): { first: number; last: number } | null {
  if (boxes.length === 0) return null;
  const first = Math.max(0, pageAt(boxes, top) - OVERSCAN);
  const last = Math.min(boxes.length - 1, pageAt(boxes, bottom) + OVERSCAN);
  return { first, last };
}

/** The page the reader is on: the one under a point a third of the way down the view. */
export function currentPage(boxes: readonly PageBox[], top: number, viewHeight: number): number {
  return pageAt(boxes, top + viewHeight / 3);
}

export interface Anchor {
  /** Zero-based. */
  page: number;
  /** How far down the page the view's top is, from 0 (its top) to 1. */
  fraction: number;
}

export function anchorAt(boxes: readonly PageBox[], top: number): Anchor {
  if (boxes.length === 0) return { page: 0, fraction: 0 };
  const page = pageAt(boxes, top);
  const box = boxes[page];
  const fraction = box.height > 0 ? (top - box.top) / box.height : 0;
  return { page, fraction: Math.min(1, Math.max(0, fraction)) };
}

/** Where `anchor` is in `layout`, clamped to the pages it has. */
export function offsetOf(layout: PageLayout, anchor: Anchor): number {
  if (layout.boxes.length === 0) return 0;
  const samePage = anchor.page < layout.boxes.length;
  const box = layout.boxes[Math.min(Math.max(0, anchor.page), layout.boxes.length - 1)];
  return box.top + (samePage ? anchor.fraction * box.height : 0);
}

/**
 * Pixel width to render pages at: the view's width in device pixels, times a whole-number zoom
 * step, so pinching re-renders sharper pages a few times rather than on every frame.
 */
export function renderWidth(viewWidth: number, pixelRatio: number, zoom: number): number {
  const step = Math.min(MAX_ZOOM, Math.max(1, Math.ceil(zoom - 0.25)));
  return Math.min(MAX_RENDER_WIDTH, Math.max(16, Math.round(viewWidth * pixelRatio * step)));
}

/** Pages from `first` to `last`, nearest to `current` first. */
export function byDistance(first: number, last: number, current: number): number[] {
  const pages: number[] = [];
  for (let page = first; page <= last; page += 1) pages.push(page);
  return pages.sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b);
}
