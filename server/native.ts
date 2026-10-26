import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { nativeOpen, nativePage } from "../shared/rpc";
import { pdfiumSource, pdfiumWasm } from "./generated/pdfium-assets.js";
import { createPdfiumHost, PdfiumError, type PdfiumHost, type WorkerLike } from "./pdfium-host";
import {
  type OpenResult,
  pdfiumWorkerMain,
  type RenderResult,
  type WasmModule,
} from "./pdfium-worker";
import { encodePng } from "./png";

// Renders pages for the iOS panel. PDFium runs in a worker thread (server/pdfium-host.ts); this
// side reads files, tracks which version of each file is open, and encodes renders as PNG.

const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** About 4096 × 4096: an A4 page at 3× zoom on a large phone, before the width cap. */
const MAX_PIXELS = 16 * 1024 * 1024;
const OPEN_TIMEOUT_MS = 30_000;
const RENDER_TIMEOUT_MS = 20_000;
/** Versions remembered for answering a repeated open without asking the worker. */
const MAX_KNOWN_DOCUMENTS = 32;

interface KnownDocument {
  revision: string;
  password: string | undefined;
  pages: { width: number; height: number }[];
}

const known = new Map<string, KnownDocument>();
const locks = new Map<string, Promise<unknown>>();
let host: PdfiumHost | null = null;
let compiled: Promise<WasmModule> | null = null;

const WORKER_SOURCE =
  'const { parentPort, workerData } = require("node:worker_threads");\n' +
  `(${pdfiumWorkerMain.toString()})(parentPort, workerData, require);\n`;

/** Runs `task` after earlier tasks for the same file, so versions of one file never interleave. */
function serially<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.catch(() => undefined);
  locks.set(file, settled);
  void settled.then(() => {
    if (locks.get(file) === settled) locks.delete(file);
  });
  return run;
}

async function startWorker(): Promise<WorkerLike> {
  const wasm = (
    globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<WasmModule> } }
  ).WebAssembly;
  compiled ??= wasm.compile(Buffer.from(pdfiumWasm, "base64")).catch((error: unknown) => {
    compiled = null;
    throw error;
  });
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { source: pdfiumSource, wasm: await compiled },
  });
  // An idle worker must not keep the plugin process alive on its own.
  worker.unref();
  return worker as unknown as WorkerLike;
}

function pdfium(): PdfiumHost {
  host ??= createPdfiumHost({ createWorker: startWorker });
  return host;
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

function remember(file: string, entry: KnownDocument): void {
  known.delete(file);
  known.set(file, entry);
  while (known.size > MAX_KNOWN_DOCUMENTS) known.delete(known.keys().next().value as string);
}

/**
 * Opens the file's current version in the worker. With `reuse`, a version the worker was already
 * given is answered from memory; a render reports it if the worker no longer has it.
 */
async function openFile(
  file: string,
  password: string | undefined,
  reuse: boolean,
): Promise<RpcOutput<typeof nativeOpen>> {
  const before = await stat(file);
  if (!before.isFile()) throw new Error("This is not a file.");
  if (before.size > MAX_FILE_BYTES) throw new Error("This PDF is larger than 512 MB.");
  const revision = revisionOf(before);

  const cached = known.get(file);
  if (reuse && cached && cached.revision === revision && cached.password === password) {
    remember(file, cached);
    return { status: "ok", revision, pages: cached.pages };
  }

  const bytes = new Uint8Array(await readFile(file));
  // A compiler may still be writing it; the app retries once the file settles.
  if (revisionOf(await stat(file)) !== revision)
    throw new Error("The PDF changed while it was read.");

  let opened: OpenResult;
  try {
    opened = (await pdfium().call(
      { op: "open", key: file, revision, bytes, password },
      { timeoutMs: OPEN_TIMEOUT_MS, transfer: [bytes.buffer as ArrayBuffer] },
    )) as OpenResult;
  } catch (error) {
    if (error instanceof PdfiumError && error.kind === "password") {
      return { status: "password", incorrect: Boolean(password) };
    }
    throw error;
  }
  remember(file, { revision, password, pages: opened.pages });
  return { status: "ok", revision, pages: opened.pages };
}

export async function openPdf({
  path: file,
  password,
}: RpcInput<typeof nativeOpen>): Promise<RpcOutput<typeof nativeOpen>> {
  const checked = checkPath(file);
  return serially(checked, () => openFile(checked, password, true));
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

async function renderBitmap(
  file: string,
  input: RpcInput<typeof nativePage>,
): Promise<RenderResult | "stale"> {
  let entry = known.get(file);
  if (!entry || entry.password !== input.password) {
    // Not opened since this process started, or opened with another password.
    const opened = await openFile(file, input.password, true);
    if (opened.status === "password") throw new Error("The PDF needs its password again.");
    entry = known.get(file);
  }
  if (!entry || entry.revision !== input.revision) return "stale";
  const size = entry.pages[input.page];
  if (!size) throw new Error(`The PDF has no page ${input.page + 1}.`);
  const request = {
    op: "render" as const,
    key: file,
    revision: input.revision,
    page: input.page,
    ...renderSize(size, input.width),
  };
  try {
    return (await pdfium().call(request, { timeoutMs: RENDER_TIMEOUT_MS })) as RenderResult;
  } catch (error) {
    if (!(error instanceof PdfiumError && error.kind === "missing")) throw error;
  }
  // The worker evicted the document or was replaced: open this version again, if it still is.
  const reopened = await openFile(file, input.password, false);
  if (reopened.status === "password") throw new Error("The PDF needs its password again.");
  if (reopened.revision !== input.revision) return "stale";
  return (await pdfium().call(request, { timeoutMs: RENDER_TIMEOUT_MS })) as RenderResult;
}

export async function renderPage(
  input: RpcInput<typeof nativePage>,
): Promise<RpcOutput<typeof nativePage>> {
  const file = checkPath(input.path);
  const bitmap = await serially(file, () => renderBitmap(file, input));
  if (bitmap === "stale") return { status: "stale" };
  // Encoding runs after the file's turn, so its next page can render meanwhile.
  const png = await encodePng(bitmap.data, bitmap.width, bitmap.height, { invert: input.invert });
  return {
    status: "ok",
    width: bitmap.width,
    height: bitmap.height,
    base64: png.toString("base64"),
  };
}

export async function disposeNative(): Promise<void> {
  host?.dispose();
  host = null;
  known.clear();
}
