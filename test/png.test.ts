import { describe, expect, it } from "vitest";
import { encodePng } from "../server/png";
import { decodePng, pixel } from "./decode-png";

function bitmap(width: number, height: number, color: (x: number, y: number) => number[]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rgba.set([...color(x, y), 255], (y * width + x) * 4);
    }
  }
  return rgba;
}

describe("encodePng", () => {
  it("round-trips an RGB bitmap and drops alpha", async () => {
    const rgba = bitmap(5, 3, (x, y) => [x * 50, y * 100, 7]);
    const image = decodePng(await encodePng(rgba, 5, 3));
    expect(image).toMatchObject({ width: 5, height: 3 });
    expect(pixel(image, 0, 0)).toEqual([0, 0, 7]);
    expect(pixel(image, 4, 2)).toEqual([200, 200, 7]);
    expect(pixel(image, 2, 1)).toEqual([100, 100, 7]);
  });

  it("inverts colors for dark themes", async () => {
    const rgba = bitmap(2, 2, () => [255, 0, 10]);
    expect(pixel(decodePng(await encodePng(rgba, 2, 2, { invert: true })), 1, 1)).toEqual([
      0, 255, 245,
    ]);
  });

  it("rejects a bitmap smaller than its size", async () => {
    await expect(encodePng(new Uint8Array(4), 2, 2)).rejects.toThrow();
  });
});
