import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as Native from "../server/native";
import { decodePng, pixel } from "./decode-png";
import { makePdf } from "./make-pdf";

// Loads server/native.ts the way Paseo's plugin compiler builds the server bundle
// (packages/server/src/server/plugins/compiler.ts), so PDFium's inlined wasm is tested as shipped.
let native: typeof Native;
let directory: string;

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), "pdfjs-native-"));
  const result = await build({
    entryPoints: ["server/native.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    logLevel: "silent",
    write: false,
  });
  const bundle = path.join(directory, "native.cjs");
  writeFileSync(bundle, result.outputFiles[0].text);
  native = createRequire(import.meta.url)(bundle) as typeof Native;
}, 30_000);

afterAll(async () => {
  await native?.disposeNative();
  rmSync(directory, { recursive: true, force: true });
});

function writePdf(name: string, sizes: { width: number; height: number }[]): string {
  const file = path.join(directory, name);
  writeFileSync(file, makePdf(sizes));
  return file;
}

describe("native rendering", () => {
  it("lists page sizes in points", async () => {
    const file = writePdf("sizes.pdf", [
      { width: 612, height: 792 },
      { width: 842, height: 595 },
    ]);
    const opened = await native.openPdf({ path: file });
    expect(opened).toMatchObject({
      status: "ok",
      pages: [
        { width: 612, height: 792 },
        { width: 842, height: 595 },
      ],
    });
  });

  it("renders a page to a PNG of the requested width", async () => {
    const file = writePdf("render.pdf", [{ width: 600, height: 800 }]);
    const opened = await native.openPdf({ path: file });
    if (opened.status !== "ok") throw new Error("not opened");
    const page = await native.renderPage({
      path: file,
      revision: opened.revision,
      page: 0,
      width: 300,
      invert: false,
    });
    if (page.status !== "ok") throw new Error("not rendered");
    expect(page).toMatchObject({ width: 300, height: 400 });
    const image = decodePng(Buffer.from(page.base64, "base64"));
    // The square spans the top-left 100 points: 50 pixels at half scale.
    expect(pixel(image, 10, 10)).toEqual([0, 0, 0]);
    expect(pixel(image, 150, 300)).toEqual([255, 255, 255]);

    const inverted = await native.renderPage({
      path: file,
      revision: opened.revision,
      page: 0,
      width: 300,
      invert: true,
    });
    if (inverted.status !== "ok") throw new Error("not rendered");
    expect(pixel(decodePng(Buffer.from(inverted.base64, "base64")), 10, 10)).toEqual([
      255, 255, 255,
    ]);
  });

  it("reports a stale revision after the file is rebuilt", async () => {
    const file = writePdf("rebuilt.pdf", [{ width: 600, height: 800 }]);
    const first = await native.openPdf({ path: file });
    if (first.status !== "ok") throw new Error("not opened");
    writeFileSync(
      file,
      makePdf([
        { width: 600, height: 800 },
        { width: 600, height: 800 },
      ]),
    );
    const second = await native.openPdf({ path: file });
    if (second.status !== "ok") throw new Error("not opened");
    expect(second.revision).not.toBe(first.revision);
    expect(second.pages).toHaveLength(2);
    expect(
      await native.renderPage({
        path: file,
        revision: first.revision,
        page: 0,
        width: 100,
        invert: false,
      }),
    ).toEqual({ status: "stale" });
  });

  it("refuses paths that are relative or not PDFs", async () => {
    await expect(native.openPdf({ path: "relative.pdf" })).rejects.toThrow(/absolute/);
    await expect(native.openPdf({ path: path.join(directory, "notes.txt") })).rejects.toThrow(
      /\.pdf/,
    );
  });

  it("reports a damaged file as an error", async () => {
    const file = path.join(directory, "broken.pdf");
    writeFileSync(file, "not a pdf");
    await expect(native.openPdf({ path: file })).rejects.toThrow();
  });
});

describe("renderSize", () => {
  it("keeps the aspect ratio", () => {
    expect(native.renderSize({ width: 600, height: 800 }, 300)).toEqual({
      width: 300,
      height: 400,
    });
  });

  it("shrinks huge renders under the pixel budget", () => {
    const size = native.renderSize({ width: 100, height: 10_000 }, 4096);
    expect(size.width * size.height).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(size.height / size.width).toBeCloseTo(100, 0);
  });
});
