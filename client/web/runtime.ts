import type * as PdfjsLib from "pdfjs-dist";
import type * as PdfjsViewer from "pdfjs-dist/web/pdf_viewer.mjs";
import { type BinaryKind, RUNTIME_PARTS, type RuntimePart } from "../../shared/rpc";
import { SCOPE_CLASS, scopeCss } from "../css-scope";
import { setRuntimeRelease } from "../runtime-release";
import type { FetchBinaryData, FetchRuntimePart } from "../viewer-types";

export interface PdfjsRuntime {
  version: string;
  lib: typeof PdfjsLib;
  viewer: typeof PdfjsViewer;
}

let loading: Promise<PdfjsRuntime> | null = null;

/**
 * Loads PDF.js once per app session. Its sources come from the plugin's server code, so the client
 * bundle stays small and free of syntax Hermes cannot parse; the modules run from blob: URLs.
 */
export function loadPdfjsRuntime(fetchPart: FetchRuntimePart): Promise<PdfjsRuntime> {
  loading ??= load(fetchPart).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

// `import()` in this bundle would stop Hermes from parsing it on iOS and Android, so build the
// call at runtime. Only web reaches this module.
const importModule = new Function("url", "return import(url)") as (url: string) => Promise<unknown>;

async function load(fetchPart: FetchRuntimePart): Promise<PdfjsRuntime> {
  const responses = await Promise.all(RUNTIME_PARTS.map((part) => fetchPart({ part })));
  const source = Object.fromEntries(
    RUNTIME_PARTS.map((part, index) => [part, responses[index].source]),
  ) as Record<RuntimePart, string>;
  const version = responses[0].version;

  const urls: string[] = [];
  const moduleUrl = (code: string) => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    urls.push(url);
    return url;
  };
  const lib = (await importModule(moduleUrl(source.pdf))) as typeof PdfjsLib;
  // pdf_viewer.mjs reads the library from globalThis.pdfjsLib, which evaluating pdf.mjs just set.
  const viewer = (await importModule(moduleUrl(source.viewer))) as typeof PdfjsViewer;
  const worker = new Worker(moduleUrl(source.worker), { type: "module", name: "paseo-pdfjs" });
  lib.GlobalWorkerOptions.workerPort = worker;

  const style = document.createElement("style");
  style.dataset.paseoPdfjs = version;
  // Without @scope support the stylesheet applies globally, which is how PDF.js ships it.
  style.textContent = ("CSSScopeRule" in globalThis ? scopeCss(source.css) : source.css) + OWN_CSS;
  document.head.appendChild(style);

  setRuntimeRelease(() => {
    worker.terminate();
    style.remove();
    for (const url of urls) URL.revokeObjectURL(url);
    loading = null;
  });
  return { version, lib, viewer };
}

const OWN_CSS = `
.${SCOPE_CLASS} .paseo-pdfjs-container { position: absolute; inset: 0; overflow: auto; outline: none; }
.${SCOPE_CLASS} .paseo-pdfjs-container.paseo-pdfjs-pending { visibility: hidden; }
.${SCOPE_CLASS}.paseo-pdfjs-invert .canvasWrapper { filter: invert(1) hue-rotate(180deg); }
`;

/**
 * PDF.js asks its BinaryDataFactory for CMaps, standard fonts, and image decoders by file name
 * (with `useWorkerFetch: false`). This one asks the plugin's server code, which embeds them.
 * `getDocument` instantiates the class with its URL options, which this factory does not need.
 */
export function binaryDataFactoryFor(fetchBinaryData: FetchBinaryData) {
  return class PaseoBinaryDataFactory {
    async fetch({ kind, filename }: { kind: BinaryKind; filename: string }): Promise<Uint8Array> {
      const { base64 } = await fetchBinaryData({ kind, filename });
      if (base64 === null) throw new Error(`The PDF viewer does not include ${kind} ${filename}.`);
      return base64ToBytes(base64);
    }
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
