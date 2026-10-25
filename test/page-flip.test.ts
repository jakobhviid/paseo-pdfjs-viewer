import { describe, expect, it } from "vitest";
import { pagingKey, WheelPageFlip } from "../client/page-flip";

const atBottom = { atTop: false, atBottom: true };
const atTop = { atTop: true, atBottom: false };
const inside = { atTop: false, atBottom: false };

describe("WheelPageFlip", () => {
  it("turns to the next page after one notch at the bottom", () => {
    const flip = new WheelPageFlip();
    expect(flip.push({ deltaY: 100, deltaMode: 0, ...atBottom })).toBe("next");
  });

  it("turns back after one notch up at the top", () => {
    const flip = new WheelPageFlip();
    expect(flip.push({ deltaY: -3, deltaMode: 1, ...atTop })).toBe("previous");
  });

  it("adds up trackpad deltas to a notch before turning", () => {
    const flip = new WheelPageFlip();
    const results = Array.from({ length: 5 }, () =>
      flip.push({ deltaY: 20, deltaMode: 0, ...atBottom }),
    );
    expect(results).toEqual([null, null, null, null, "next"]);
  });

  it("starts over when the view leaves the edge or the direction reverses", () => {
    const flip = new WheelPageFlip();
    flip.push({ deltaY: 60, deltaMode: 0, ...atBottom });
    flip.push({ deltaY: -10, deltaMode: 0, ...inside });
    expect(flip.push({ deltaY: 60, deltaMode: 0, ...atBottom })).toBeNull();
    // A page that fits is at both edges; reversing starts a new count.
    const fits = { atTop: true, atBottom: true };
    flip.push({ deltaY: 60, deltaMode: 0, ...fits });
    expect(flip.push({ deltaY: -60, deltaMode: 0, ...fits })).toBeNull();
    expect(flip.push({ deltaY: -60, deltaMode: 0, ...fits })).toBe("previous");
  });

  it("never turns while scrolling inside the page", () => {
    const flip = new WheelPageFlip();
    expect(flip.push({ deltaY: 300, deltaMode: 0, ...inside })).toBeNull();
  });
});

describe("pagingKey", () => {
  const key = (
    k: string,
    mods: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {},
  ) =>
    pagingKey({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });

  it("maps Down, PageDown, and Space down; Up, PageUp, and Shift+Space up", () => {
    expect([key("ArrowDown"), key("PageDown"), key(" ")]).toEqual(["down", "down", "down"]);
    expect([key("ArrowUp"), key("PageUp"), key(" ", { shiftKey: true })]).toEqual([
      "up",
      "up",
      "up",
    ]);
  });

  it("leaves other keys and modified keys alone", () => {
    expect([
      key("ArrowLeft"),
      key("ArrowDown", { ctrlKey: true }),
      key("PageDown", { shiftKey: true }),
    ]).toEqual([null, null, null]);
  });
});
