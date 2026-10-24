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
