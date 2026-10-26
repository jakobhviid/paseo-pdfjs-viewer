import { describe, expect, it } from "vitest";
import {
  isCurrent,
  keptRange,
  type PageImage,
  prunedImages,
  statusMessage,
  summarizeStack,
  wantedRenders,
  withImage,
} from "../client/native-state";

const image = (overrides: Partial<PageImage> = {}): PageImage => ({
  id: 1,
  uri: "data:image/png;base64,",
  revision: "r1",
  width: 1170,
  invert: false,
  ...overrides,
});

describe("isCurrent", () => {
  it("accepts an image of this version, color, and at least this width", () => {
    expect(isCurrent(image(), "r1", false, 1170)).toBe(true);
    expect(isCurrent(image({ width: 2340 }), "r1", false, 1170)).toBe(true);
  });

  it("rejects a missing, older, differently colored, or blurrier image", () => {
    expect(isCurrent(undefined, "r1", false, 1170)).toBe(false);
    expect(isCurrent(image({ revision: "r0" }), "r1", false, 1170)).toBe(false);
    expect(isCurrent(image({ invert: true }), "r1", false, 1170)).toBe(false);
    expect(isCurrent(image(), "r1", false, 2340)).toBe(false);
  });
});

describe("wantedRenders", () => {
  it("asks for the pages around the view without a current image, nearest first", () => {
    const viewport = { first: 2, last: 6, current: 4, width: 1170 };
    const renders = wantedRenders(viewport, "r1", false, {
      4: image(),
      3: image({ revision: "r0" }),
    });
    expect(renders.map((render) => render.page)).toEqual([3, 5, 2, 6]);
    expect(renders[0]).toEqual({
      key: "r1:3:1170:false",
      page: 3,
      revision: "r1",
      width: 1170,
      invert: false,
    });
  });

  it("asks again at a sharper width after zooming", () => {
    const viewport = { first: 0, last: 0, current: 0, width: 2340 };
    expect(wantedRenders(viewport, "r1", false, { 0: image() })).toHaveLength(1);
  });

  it("leaves pages whose render failed until they are retried", () => {
    const viewport = { first: 0, last: 2, current: 1, width: 1170 };
    const renders = wantedRenders(viewport, "r1", false, {}, { 1: "The PDF took too long." });
    expect(renders.map((render) => render.page)).toEqual([0, 2]);
  });
});

describe("withImage", () => {
  it("keeps a sharper image of the same version", () => {
    const images = { 0: image({ id: 1, width: 2340 }) };
    expect(withImage(images, 0, image({ id: 2, width: 1170 }))).toBe(images);
  });

  it("replaces an image of an older version or another color, even if sharper", () => {
    const images = { 0: image({ id: 1, width: 2340, revision: "r0" }) };
    expect(withImage(images, 0, image({ id: 2 }))[0].id).toBe(2);
    expect(withImage({ 0: image({ width: 2340, invert: true }) }, 0, image({ id: 3 }))[0].id).toBe(
      3,
    );
  });
});

describe("kept images", () => {
  it("keeps the visible pages and a margin, within the document", () => {
    expect(keptRange({ first: 1, last: 2, current: 1, width: 1 }, 5)).toEqual({ low: 0, high: 4 });
    expect(keptRange({ first: 10, last: 11, current: 10, width: 1 }, 30)).toEqual({
      low: 6,
      high: 15,
    });
  });

  it("drops images outside the range, and returns the same object when none are", () => {
    const images = { 1: image(), 5: image(), 20: image() };
    expect(Object.keys(prunedImages(images, { low: 0, high: 6 }))).toEqual(["1", "5"]);
    const near = { 1: image() };
    expect(prunedImages(near, { low: 0, high: 6 })).toBe(near);
  });
});

describe("statusMessage", () => {
  const idle = { state: "idle" as const, error: null };

  it("says nothing before the first version or while all is well", () => {
    expect(
      statusMessage({ loaded: false, reload: { state: "failed", error: "x" }, deleted: false }),
    ).toBeNull();
    expect(statusMessage({ loaded: true, reload: idle, deleted: false })).toBeNull();
  });

  it("reports a deleted file, a failed reload, and a retry", () => {
    expect(statusMessage({ loaded: true, reload: idle, deleted: true })?.danger).toBe(false);
    expect(
      statusMessage({ loaded: true, reload: { state: "failed", error: "x" }, deleted: false }),
    ).toMatchObject({
      danger: true,
      retry: true,
    });
    expect(
      statusMessage({ loaded: true, reload: { state: "waiting", error: "x" }, deleted: false })
        ?.text,
    ).toMatch(/Retrying/);
  });
});

describe("summarizeStack", () => {
  it("lists the innermost components", () => {
    const stack =
      "\n    in Image (at native-panel.tsx:1)\n    in PageLayer\n    in View\n    in PageView";
    expect(summarizeStack(stack, 3)).toBe("Image ‹ PageLayer ‹ View");
  });
});
