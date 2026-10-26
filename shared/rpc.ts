import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const RUNTIME_PARTS = ["pdf", "viewer", "worker", "css"] as const;
export type RuntimePart = (typeof RUNTIME_PARTS)[number];

/** One source file of the PDF.js runtime, which the app loads on web only. */
export const runtimePart = defineRpc({
  name: "pdfjs.runtime.part",
  input: z.object({ part: z.enum(RUNTIME_PARTS) }),
  output: z.object({ version: z.string(), source: z.string() }),
});

/** Kinds match the `kind` PDF.js passes to its BinaryDataFactory. */
export const BINARY_KINDS = ["cMapUrl", "standardFontDataUrl", "wasmUrl"] as const;
export type BinaryKind = (typeof BINARY_KINDS)[number];

/** A CMap, standard font, or image decoder that the PDF.js worker asks for while parsing. */
export const binaryData = defineRpc({
  name: "pdfjs.binary",
  input: z.object({ kind: z.enum(BINARY_KINDS), filename: z.string().min(1).max(200) }),
  output: z.object({ base64: z.string().nullable() }),
});

/**
 * iOS has no web view that runs scripts, so PDF.js cannot run there. The daemon renders pages with
 * PDFium instead, and the app shows them as images. Paths are absolute paths on the daemon host,
 * from the file panel's `file.path`.
 */
const pdfPath = z.string().min(1).max(4096);
const password = z.string().max(1024).optional();

/** Opens the current version of a PDF and lists its page sizes in PDF points. */
export const nativeOpen = defineRpc({
  name: "pdfjs.native.open",
  input: z.object({ path: pdfPath, password }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      /** Identifies this version of the file; page renders name it. */
      revision: z.string(),
      pages: z.array(z.object({ width: z.number(), height: z.number() })),
    }),
    /** The PDF needs a password; `incorrect` is true when one was given. */
    z.object({ status: z.literal("password"), incorrect: z.boolean() }),
  ]),
});

/** Renders one page of an opened revision to a PNG `width` pixels wide. */
export const nativePage = defineRpc({
  name: "pdfjs.native.page",
  input: z.object({
    path: pdfPath,
    password,
    revision: z.string(),
    /** Zero-based. */
    page: z.number().int().min(0),
    width: z.number().int().min(16).max(4096),
    invert: z.boolean(),
  }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      width: z.number().int(),
      height: z.number().int(),
      base64: z.string(),
    }),
    /** The file changed since `revision` was opened; open it again. */
    z.object({ status: z.literal("stale") }),
  ]),
});
