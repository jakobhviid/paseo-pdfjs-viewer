import { describe, expect, it } from "vitest";
import {
  actionBarPosition,
  imageScale,
  isUsableArea,
  joinTextPieces,
  rectFromPoints,
  type TextPiece,
} from "../client/area";

const page = { width: 600, height: 800 };

describe("rectFromPoints", () => {
  it("normalizes a drag in any direction", () => {
    expect(rectFromPoints({ x: 300, y: 400 }, { x: 100, y: 250 }, page)).toEqual({
      x: 100,
      y: 250,
      width: 200,
      height: 150,
    });
  });

  it("stops at the page's edges", () => {
    expect(rectFromPoints({ x: 550, y: 750 }, { x: 900, y: -40 }, page)).toEqual({
      x: 550,
      y: 0,
      width: 50,
      height: 750,
    });
  });

  it("treats a click as no area", () => {
    expect(isUsableArea(rectFromPoints({ x: 10, y: 10 }, { x: 12, y: 30 }, page))).toBe(false);
  });
});

describe("imageScale", () => {
  it("renders at twice the screen density, at least 2", () => {
    expect(imageScale({ x: 0, y: 0, width: 200, height: 100 }, 1)).toBe(2);
    expect(imageScale({ x: 0, y: 0, width: 200, height: 100 }, 2)).toBe(4);
  });

  it("keeps a large area under the pixel budget", () => {
    const rect = { x: 0, y: 0, width: 2000, height: 3000 };
    const scale = imageScale(rect, 2);
    expect(rect.width * scale * rect.height * scale).toBeLessThanOrEqual(16_000_000);
  });
});

describe("actionBarPosition", () => {
  const bar = { width: 160, height: 28 };

  it("goes below the area, aligned to its right edge", () => {
    expect(actionBarPosition({ x: 100, y: 100, width: 300, height: 100 }, page, bar)).toEqual({
      x: 240,
      y: 206,
    });
  });

  it("goes above an area that reaches the bottom of the page", () => {
    expect(actionBarPosition({ x: 100, y: 600, width: 300, height: 195 }, page, bar).y).toBe(566);
  });

  it("stays on the page for a narrow area at its left edge", () => {
    expect(actionBarPosition({ x: 0, y: 100, width: 40, height: 40 }, page, bar).x).toBe(0);
  });
});

describe("joinTextPieces", () => {
  const piece = (text: string, left: number, right: number, top: number): TextPiece => ({
    text,
    left,
    right,
    top,
    bottom: top + 12,
  });

  it("starts a new line when a piece moves down a line", () => {
    expect(joinTextPieces([piece("First line", 0, 90, 100), piece("second", 0, 60, 115)])).toBe(
      "First line\nsecond",
    );
  });

  it("joins pieces on one line, adding a space only for a visible gap", () => {
    expect(
      joinTextPieces([piece("a^2", 0, 20, 100), piece("+b", 20, 32, 101), piece("holds", 40, 80, 100)]),
    ).toBe("a^2+b holds");
  });

  it("drops trailing spaces from each line", () => {
    expect(joinTextPieces([piece("text   ", 0, 60, 100), piece("more", 0, 40, 120)])).toBe("text\nmore");
  });
});
