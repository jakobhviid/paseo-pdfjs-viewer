import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { type PDFiumDocument, PDFiumLibrary } from "@hyzyla/pdfium/inline";
import type { nativeOpen, nativePage } from "../shared/rpc";
import { encodePng } from "./png";

// Renders pages for the iOS panel. PDFium is WebAssembly with its binary inlined in the bundle, so
// nothing has to be installed on the host. Rendering is synchronous, so a heavy page holds up this
// plugin's other requests for its duration; calls run one at a time to keep PDFium's single
// instance consistent.

/** Documents kept open, one per path, the least recently used closed first. */
const MAX_OPEN_DOCUMENTS = 4;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** About 4096 × 4096: an A4 page at 3× zoom on a large phone, before the width cap. */
const MAX_PIXELS = 16 * 1024 * 1024;

interface OpenDocument {
  revision: string;
  password: string | undefined;
  document: PDFiumDocument;
  pages: { width: number; height: number }[];
}

let library: Promise<PDFiumLibrary> | null = null;
const documents = new Map<string, OpenDocument>();
let queue: Promise<unknown> = Promise.resolve();

function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function pdfium(): Promise<PDFiumLibrary> {
  library ??= PDFiumLibrary.init({ disableBase64Warning: true }).catch((error: unknown) => {
    library = null;
    throw error;
  });
  return library;
}

export function revisionOf(stats: Stats): string {
  return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`;
}

function checkPath(file: string): string {
  if (!path.isAbsolute(file)) throw new Error("The PDF path must be absolute.");
  if (path.extname(file).toLowerCase() !== ".pdf")
    throw new Error("Only .pdf files can be opened.");
  return path.normalize(file);
}

function remember(file: string, entry: OpenDocument): void {
  const previous = documents.get(file);
  if (previous && previous !== entry) previous.document.destroy();
  documents.delete(file);
  documents.set(file, entry);
  while (documents.size > MAX_OPEN_DOCUMENTS) {
    const [oldest, evicted] = documents.entries().next().value as [string, OpenDocument];
    documents.delete(oldest);
    evicted.document.destroy();
  }
}

async function openUnlocked(
  file: string,
  password: string | undefined,
): Promise<RpcOutput<typeof nativeOpen>> {
  const before = await stat(file);
  if (!before.isFile()) throw new Error("This is not a file.");
  if (before.size > MAX_FILE_BYTES) throw new Error("This PDF is larger than 512 MB.");
  const revision = revisionOf(before);

  const cached = documents.get(file);
  if (cached && cached.revision === revision && cached.password === password) {
    remember(file, cached);
    return { status: "ok", revision, pages: cached.pages };
  }

  const bytes = await readFile(file);
  // A compiler may still be writing it; the app retries once the file settles.
  if (revisionOf(await stat(file)) !== revision)
    throw new Error("The PDF changed while it was read.");

  let document: PDFiumDocument;
  try {
    document = await (await pdfium()).loadDocument(new Uint8Array(bytes), password);
  } catch (error) {
    if (error instanceof Error && /password/i.test(error.message)) {
      return { status: "password", incorrect: Boolean(password) };
    }
    throw error;
  }
  const pages: OpenDocument["pages"] = [];
  try {
    const count = document.getPageCount();
    for (let index = 0; index < count; index += 1) {
      const page = document.getPage(index);
      try {
        const { originalWidth, originalHeight } = page.getOriginalSize();
        pages.push({ width: originalWidth, height: originalHeight });
      } finally {
        page.close();
      }
    }
  } catch (error) {
    document.destroy();
    throw error;
  }
  remember(file, { revision, password, document, pages });
  return { status: "ok", revision, pages };
}

export function openPdf({ path: file, password }: RpcInput<typeof nativeOpen>) {
  return exclusive(() => openUnlocked(checkPath(file), password));
}

/** Pixel size for a page `width` pixels wide, shrunk to stay under MAX_PIXELS. */
export function renderSize(
  page: { width: number; height: number },
  width: number,
): { width: number; height: number } {
  const aspect = page.height / page.width;
  let w = Math.max(1, Math.round(width));
  let h = Math.max(1, Math.round(w * aspect));
  if (w * h > MAX_PIXELS) {
    const shrink = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.max(1, Math.floor(w * shrink));
    h = Math.max(1, Math.floor(w * aspect));
  }
  return { width: w, height: h };
}

export function renderPage(
  input: RpcInput<typeof nativePage>,
): Promise<RpcOutput<typeof nativePage>> {
  return exclusive(async () => {
    const file = checkPath(input.path);
    let entry = documents.get(file);
    if (!entry || entry.password !== input.password) {
      // Evicted, or this subprocess restarted since the app opened the file.
      const opened = await openUnlocked(file, input.password);
      if (opened.status === "password") throw new Error("The PDF needs its password again.");
      entry = documents.get(file);
    }
    if (!entry || entry.revision !== input.revision) return { status: "stale" };
    const size = entry.pages[input.page];
    if (!size) throw new Error(`The PDF has no page ${input.page + 1}.`);

    const target = renderSize(size, input.width);
    const page = entry.document.getPage(input.page);
    try {
      const bitmap = await page.render({ width: target.width, height: target.height, scale: 1 });
      const png = encodePng(bitmap.data, bitmap.width, bitmap.height, { invert: input.invert });
      return {
        status: "ok",
        width: bitmap.width,
        height: bitmap.height,
        base64: png.toString("base64"),
      };
    } finally {
      page.close();
    }
  });
}

export function disposeNative(): Promise<void> {
  return exclusive(async () => {
    for (const entry of documents.values()) entry.document.destroy();
    documents.clear();
    const loaded = library;
    library = null;
    if (loaded) (await loaded.catch(() => null))?.destroy();
  });
}
