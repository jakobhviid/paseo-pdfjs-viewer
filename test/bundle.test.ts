import { build } from "esbuild";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Mirrors the client options in Paseo's plugin compiler (packages/server/src/server/plugins/compiler.ts).
const HOST_MODULES = [
  "@getpaseo/plugin",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@tanstack/react-query",
  "react",
  "react/jsx-runtime",
  "react-native",
  "zod",
];

async function compileClient(): Promise<string> {
  const result = await build({
    entryPoints: ["index.client.tsx"],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "neutral",
    target: "es2020",
    mainFields: ["module", "main"],
    supported: { "async-await": false },
    external: HOST_MODULES,
    logLevel: "silent",
    write: false,
  });
  return result.outputFiles[0].text;
}

describe("client bundle", () => {
  it("contains no import() syntax, which stops Hermes from parsing it on iOS and Android", async () => {
    // The one import() is built at runtime from a string, which Hermes never parses as code.
    const bundle = (await compileClient()).replaceAll('"return import(url)"', '""');
    expect(bundle).not.toMatch(/\bimport\s*\(/);
  });

  it("leaves PDF.js out; the app loads it from the plugin server on web", async () => {
    const bundle = await compileClient();
    expect(bundle).not.toContain("pdfjsLib");
    expect(bundle).not.toContain("FPDF_");
    expect(bundle.length).toBeLessThan(200_000);
  });
});

describe("server bundle", () => {
  it.runIf(existsSync("server/generated/pdfjs-assets.js"))(
    "inlines PDFium for the iOS renderer, leaving only host modules external",
    async () => {
      // Mirrors the server options in Paseo's plugin compiler.
      const result = await build({
        entryPoints: ["index.server.ts"],
        bundle: true,
        format: "cjs",
        platform: "node",
        target: "node20",
        external: ["@getpaseo/plugin", "@getpaseo/plugin/server", "zod"],
        logLevel: "silent",
        write: false,
      });
      const bundle = result.outputFiles[0].text;
      expect(bundle).not.toMatch(/require\(["']@hyzyla\/pdfium/);
      expect(bundle).toContain("FPDF_LoadMemDocument");
    },
    30_000,
  );

  it.runIf(existsSync("server/generated/pdfjs-assets.js"))(
    "embeds the PDF.js runtime and its binary data",
    async () => {
      const { binary, runtime } = await import("../server/generated/pdfjs-assets.js");
      expect(Object.keys(runtime).sort()).toEqual(["css", "pdf", "viewer", "worker"]);
      expect(runtime.css).not.toMatch(/url\(["']?images\//);
      expect(Object.keys(binary.cMapUrl).length).toBeGreaterThan(100);
      expect(binary.standardFontDataUrl).toHaveProperty(["FoxitSymbol.pfb"]);
    },
  );
});
