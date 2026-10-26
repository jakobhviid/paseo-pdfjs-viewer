import { describe, expect, it } from "vitest";
import { linkedPage } from "../client/page-link";

describe("linkedPage", () => {
  it("reads the linked line as a 1-based page", () => {
    expect(linkedPage({ lineStart: 5 })).toBe(5);
    expect(linkedPage({ lineStart: 1 })).toBe(1);
  });

  it("ignores links without a usable page", () => {
    expect(linkedPage({})).toBeNull();
    expect(linkedPage({ lineStart: 0 })).toBeNull();
    expect(linkedPage({ lineStart: 2.5 })).toBeNull();
  });
});
