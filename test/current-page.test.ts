import { describe, expect, it } from "vitest";
import { isPinHeld, type PageBox, pageNearestCenter } from "../client/current-page";

// Pages 1000 tall with 10 between them, in a view 800 tall and 700 wide.
const page = (n: number, left = 0, width = 700): PageBox => ({
  page: n,
  left,
  right: left + width,
  top: (n - 1) * 1010,
  bottom: (n - 1) * 1010 + 1000,
});
const viewAt = (top: number) => ({ left: 0, right: 700, top, bottom: top + 800 });

describe("pageNearestCenter", () => {
  it("picks the page under the view's center while the view straddles two pages", () => {
    // View center at 3030 + 400 = 3430: inside page 4 (3030-4030).
    expect(pageNearestCenter([page(3), page(4)], viewAt(3030))).toBe(4);
    // View starts 70% into page 4 (top 3730), so its center (4130) is past page 4's end.
    expect(pageNearestCenter([page(4), page(5)], viewAt(3730))).toBe(5);
    // 55% into page 4 (top 3580): center 3980 is still in page 4.
    expect(pageNearestCenter([page(4), page(5)], viewAt(3580))).toBe(4);
  });

  it("with several whole pages visible, picks the one nearest the middle", () => {
    const small = (n: number): PageBox => ({
      page: n,
      left: 0,
      right: 300,
      top: (n - 1) * 210,
      bottom: (n - 1) * 210 + 200,
    });
    const view = { left: 0, right: 300, top: 0, bottom: 800 };
    expect(pageNearestCenter([small(1), small(2), small(3), small(4)], view)).toBe(2);
  });

  it("gives an exact tie to the earlier page", () => {
    const view = { left: 0, right: 708, top: 0, bottom: 100 };
    // Centers at x = 100 and x = 600; the view's center, nudged left, is x = 350.
    const left: PageBox = { page: 7, left: 0, right: 200, top: 0, bottom: 100 };
    const right: PageBox = { page: 8, left: 500, right: 700, top: 0, bottom: 100 };
    expect(pageNearestCenter([left, right], view)).toBe(7);
  });

  it("has no page when nothing is visible", () => {
    expect(pageNearestCenter([], viewAt(0))).toBeNull();
  });
});

describe("isPinHeld", () => {
  const pin = { page: 6, scrollLeft: 0, scrollTop: 5050 };

  it("holds while the view stays where the jump left it", () => {
    expect(isPinHeld(pin, { scrollLeft: 0, scrollTop: 5050.4 })).toBe(true);
  });

  it("is released by the reader scrolling", () => {
    expect(isPinHeld(pin, { scrollLeft: 0, scrollTop: 5090 })).toBe(false);
    expect(isPinHeld(null, { scrollLeft: 0, scrollTop: 5050 })).toBe(false);
  });
});
