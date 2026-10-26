import { describe, expect, it } from "vitest";
import {
  anchorAt,
  byDistance,
  currentPage,
  layoutPages,
  offsetOf,
  PAGE_GAP,
  renderWidth,
  visibleRange,
} from "../client/native-layout";

const letter = { width: 612, height: 792 };
const landscape = { width: 792, height: 612 };

describe("layoutPages", () => {
  it("fills the width and stacks pages with a gap", () => {
    const layout = layoutPages([letter, landscape], 306);
    expect(layout.boxes).toEqual([
      { top: 0, height: 396 },
      { top: 396 + PAGE_GAP, height: (306 * 612) / 792 },
    ]);
    expect(layout.height).toBeCloseTo(396 + PAGE_GAP + 236.45, 1);
  });

  it("is empty without pages", () => {
    expect(layoutPages([], 300)).toEqual({ boxes: [], height: 0 });
  });
});

describe("visibleRange and currentPage", () => {
  const { boxes } = layoutPages(
    Array.from({ length: 10 }, () => letter),
    306,
  );

  it("covers the visible pages plus one on each side", () => {
    expect(visibleRange(boxes, 0, 500)).toEqual({ first: 0, last: 2 });
    expect(visibleRange(boxes, 2000, 2500)).toEqual({ first: 3, last: 7 });
    expect(visibleRange(boxes, 4000, 4500)).toEqual({ first: 8, last: 9 });
    expect(visibleRange([], 0, 100)).toBeNull();
  });

  it("reads the page a third of the way down", () => {
    expect(currentPage(boxes, 0, 600)).toBe(0);
    expect(currentPage(boxes, 300, 600)).toBe(1);
  });
});

describe("anchors", () => {
  it("keeps the place in a page across a rebuild that adds pages before the end", () => {
    const before = layoutPages([letter, letter, letter], 306);
    const anchor = anchorAt(before.boxes, before.boxes[1].top + 99);
    expect(anchor.page).toBe(1);
    expect(anchor.fraction).toBeCloseTo(0.25);
    const after = layoutPages([letter, landscape, letter, letter], 306);
    expect(offsetOf(after, anchor)).toBeCloseTo(after.boxes[1].top + 0.25 * after.boxes[1].height);
  });

  it("goes to the last page's top when the page is gone", () => {
    const after = layoutPages([letter, letter], 306);
    expect(offsetOf(after, { page: 5, fraction: 0.5 })).toBe(after.boxes[1].top);
  });
});

describe("renderWidth", () => {
  it("renders at device pixels, in whole zoom steps", () => {
    expect(renderWidth(390, 3, 1)).toBe(1170);
    expect(renderWidth(390, 3, 1.2)).toBe(1170);
    expect(renderWidth(390, 3, 1.6)).toBe(2340);
    expect(renderWidth(390, 3, 3)).toBe(3510);
    expect(renderWidth(390, 3, 4)).toBe(4096);
  });
});

describe("byDistance", () => {
  it("orders pages nearest the current one first", () => {
    expect(byDistance(2, 6, 4)).toEqual([4, 3, 5, 2, 6]);
  });
});
