import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scopeCss } from "../client/css-scope";
import { findStatusLabel } from "../client/find-label";
import { isExternalLink } from "../client/links";
import { throttle } from "../client/throttle";
import { binaryDataBase64, type PdfjsAssets, runtimePartSource } from "../server/assets";

describe("scopeCss", () => {
  it("confines the stylesheet to the viewer and moves :root variables onto it", () => {
    const css = ":root { --page-bg: white; }\n.textLayer { opacity: 1; }";
    expect(scopeCss(css, "viewer-root")).toBe(
      "@scope (.viewer-root) {\n:scope { --page-bg: white; }\n.textLayer { opacity: 1; }\n}\n",
    );
  });
});

describe("findStatusLabel", () => {
  const status = { query: "lemma", current: 2, total: 7, state: "found" } as const;

  it("counts matches for the query that produced them", () => {
    expect(findStatusLabel(status, "lemma")).toBe("2 of 7");
  });

  it("shows nothing while the field holds a query that has not run yet", () => {
    expect(findStatusLabel(status, "lemmas")).toBe("");
  });

  it("says when nothing matched", () => {
    expect(findStatusLabel({ ...status, current: 0, total: 0, state: "not-found" }, "lemma")).toBe(
      "No matches",
    );
  });
});

describe("throttle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers the latest call once per interval and on flush", () => {
    const calls: number[] = [];
    const throttled = throttle((value: number) => calls.push(value), 500);
    throttled(1);
    throttled(2);
    vi.advanceTimersByTime(500);
    throttled(3);
    throttled.flush();
    vi.advanceTimersByTime(500);
    expect(calls).toEqual([2, 3]);
  });
});

describe("server assets", () => {
  const assets: PdfjsAssets = {
    version: "6.4.299",
    runtime: { pdf: "pdf", viewer: "viewer", worker: "worker", css: "css" },
    binary: { cMapUrl: { "UniGB-UCS2-H.bcmap": "AAEC" }, standardFontDataUrl: {}, wasmUrl: {} },
  };

  it("serves runtime parts with the PDF.js version", () => {
    expect(runtimePartSource(assets, "worker")).toEqual({ version: "6.4.299", source: "worker" });
  });

  it("serves embedded files by exact name only", () => {
    expect(binaryDataBase64(assets, "cMapUrl", "UniGB-UCS2-H.bcmap")).toEqual({ base64: "AAEC" });
    expect(binaryDataBase64(assets, "cMapUrl", "../package.json")).toEqual({ base64: null });
    expect(binaryDataBase64(assets, "cMapUrl", "__proto__")).toEqual({ base64: null });
    expect(binaryDataBase64(assets, "cMapUrl", "hasOwnProperty")).toEqual({ base64: null });
  });
});

describe("isExternalLink", () => {
  it("sends web and mail links out", () => {
    expect(isExternalLink("https://typst.app/docs")).toBe(true);
    expect(isExternalLink("mailto:qa@example.com")).toBe(true);
  });

  it("leaves PDF.js's in-document destinations to the viewer", () => {
    expect(isExternalLink("#%5B%7B%22num%22%3A12%7D%5D")).toBe(false);
    expect(isExternalLink("")).toBe(false);
  });
});
