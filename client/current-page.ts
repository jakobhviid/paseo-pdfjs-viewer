// Which page is "current", as Okular decides it (part/pageview.cpp, slotRequestVisiblePixmaps and
// slotRealNotifyViewportChanged). Kept free of the DOM so it can be tested.

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PageBox extends Box {
  page: number;
}

/**
 * The visible page whose center is nearest the view's center, with the view's center nudged 4
 * pixels left as Okular does. `pages` are in document order; on an exact tie the earlier page
 * wins, because only a strictly smaller distance replaces the pick.
 */
export function pageNearestCenter(pages: readonly PageBox[], view: Box): number | null {
  const centerX = (view.left + view.right) / 2 - 4;
  const centerY = (view.top + view.bottom) / 2;
  let nearest: number | null = null;
  let minDistance = Number.POSITIVE_INFINITY;
  for (const box of pages) {
    const distance = Math.hypot(
      (box.left + box.right) / 2 - centerX,
      (box.top + box.bottom) / 2 - centerY,
    );
    if (nearest !== null && distance >= minDistance) continue;
    nearest = box.page;
    minDistance = distance;
  }
  return nearest;
}

/** A page the viewer moved to itself, with where that move left the scroll position. */
export interface PinnedPage {
  page: number;
  scrollLeft: number;
  scrollTop: number;
}

/**
 * Okular keeps the page it navigated to (an arrow key, the page box, a link) as current until the
 * reader scrolls, and only then picks the page nearest the center again. A pin holds while the
 * scroll position is where the move left it.
 */
export function isPinHeld(
  pin: PinnedPage | null,
  scroll: { scrollLeft: number; scrollTop: number },
): pin is PinnedPage {
  return (
    pin !== null &&
    Math.abs(pin.scrollTop - scroll.scrollTop) < 1 &&
    Math.abs(pin.scrollLeft - scroll.scrollLeft) < 1
  );
}
