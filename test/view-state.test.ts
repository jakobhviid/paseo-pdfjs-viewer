import { describe, expect, it } from "vitest";
import {
  defaultSavedView,
  restoreTarget,
  savedViewFromLocation,
  savedViewSchema,
  scaleLabel,
  scaleValueFromLocation,
} from "../client/view-state";

describe("scaleValueFromLocation", () => {
  it("turns PDF.js's percentage into the scale value the viewer accepts", () => {
    expect(scaleValueFromLocation(125)).toBe("1.25");
  });

  it("keeps presets so a fitted view stays fitted", () => {
    expect(scaleValueFromLocation("page-width")).toBe("page-width");
  });

  it("falls back to automatic for anything it does not recognise", () => {
    expect(scaleValueFromLocation("bogus")).toBe("auto");
  });
});

describe("savedViewFromLocation", () => {
  it("records the page, scale, and the view's corner in PDF points", () => {
    const view = savedViewFromLocation(
      { pageNumber: 3, scale: "page-fit", left: -12.4, top: 701.6 },
      true,
    );
    expect(view).toEqual({ page: 3, scale: "page-fit", left: -12, top: 702, invert: true });
    expect(savedViewSchema.parse(view)).toEqual(view);
  });
});

describe("restoreTarget", () => {
  it("returns to the saved corner of the saved page, keeping the zoom", () => {
    const target = restoreTarget({ ...defaultSavedView, page: 4, scale: "1.5", left: 10, top: 500 }, 9);
    expect(target).toEqual({
      scaleValue: "1.5",
      pageNumber: 4,
      destArray: [null, { name: "XYZ" }, 10, 500, null],
    });
  });

  it("shows the last page's top when a rebuild removed the saved page", () => {
    const target = restoreTarget({ ...defaultSavedView, page: 12, left: 0, top: 300 }, 5);
    expect(target.pageNumber).toBe(5);
    expect(target.destArray).toBeNull();
  });

  it("shows the page's top when no position was saved", () => {
    expect(restoreTarget(defaultSavedView, 3).destArray).toBeNull();
  });
});

describe("scaleLabel", () => {
  it("names fit presets and shows percentages otherwise", () => {
    expect(scaleLabel("page-width", 1.3)).toBe("Fit width");
    expect(scaleLabel("auto", 0.853)).toBe("85%");
    expect(scaleLabel("1.25", 1.25)).toBe("125%");
  });
});
