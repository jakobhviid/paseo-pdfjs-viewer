// Page flipping in one-page-at-a-time mode, following Okular (part/pageview.cpp: wheelEvent,
// slotScrollUp, slotScrollDown). Kept free of the DOM so it can be tested.

export type FlipDirection = "next" | "previous";

export interface WheelInput {
  deltaY: number;
  /** WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  atTop: boolean;
  atBottom: boolean;
}

/** One mouse wheel notch, in each delta mode; trackpads send many smaller deltas. */
const NOTCH = [100, 3, 1];

/**
 * Okular scrolls within the page as usual; at the bottom (or top) edge it adds up wheel movement
 * in that direction and turns the page once a full notch has accumulated. Moving away from the
 * edge, or reversing, starts over.
 */
export class WheelPageFlip {
  private accumulated = 0;

  push({ deltaY, deltaMode, atTop, atBottom }: WheelInput): FlipDirection | null {
    const notches = deltaY / (NOTCH[deltaMode] ?? NOTCH[0]);
    if (notches > 0 && atBottom) {
      if (this.accumulated < 0) this.accumulated = 0;
      this.accumulated += notches;
      if (this.accumulated >= 1 - 1e-9) {
        this.accumulated = 0;
        return "next";
      }
      return null;
    }
    if (notches < 0 && atTop) {
      if (this.accumulated > 0) this.accumulated = 0;
      this.accumulated += notches;
      if (this.accumulated <= -1 + 1e-9) {
        this.accumulated = 0;
        return "previous";
      }
      return null;
    }
    this.accumulated = 0;
    return null;
  }
}

/**
 * Keys that scroll down or up, and turn the page at the edge in one-page mode: Down, PageDown,
 * and Space go down; Up, PageUp, and Shift+Space go up. Other modifiers leave the key alone.
 */
export function pagingKey(event: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): "down" | "up" | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === " ") return event.shiftKey ? "up" : "down";
  if (event.shiftKey) return null;
  if (event.key === "ArrowDown" || event.key === "PageDown") return "down";
  if (event.key === "ArrowUp" || event.key === "PageUp") return "up";
  return null;
}
