// The PDFium render worker. `pdfiumWorkerMain` runs in a worker thread from its own source text
// (see server/pdfium-host.ts), so it may use only its parameters and globals: no imports and no
// module-level names.

/** A compiled WebAssembly.Module; the type checker here has no DOM types to name it. */
export type WasmModule = object;

export interface WorkerData {
  /** The CommonJS build of @hyzyla/pdfium, from server/generated/pdfium-assets.js. */
  source: string;
  /** pdfium.wasm, compiled once by the host and shared with each worker it starts. */
  wasm: WasmModule;
}

export type WorkerRequest =
  | {
      id: number;
      op: "open";
      key: string;
      revision: string;
      bytes: Uint8Array;
      password?: string;
    }
  | {
      id: number;
      op: "render";
      key: string;
      revision: string;
      page: number;
      width: number;
      height: number;
    };

export type WorkerFailure =
  /** The document needs a password, or a different one. */
  | { kind: "password" }
  /** No open document for this key and revision; open it again. */
  | { kind: "missing" }
  | { kind: "error"; message: string }
  /** PDFium aborted; this worker must not be used again. */
  | { kind: "fatal"; message: string };

export type WorkerResponse =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; failure: WorkerFailure };

export interface OpenResult {
  pages: { width: number; height: number }[];
}

export interface RenderResult {
  width: number;
  height: number;
  /** RGBA, opaque. */
  data: Uint8Array;
}

interface WorkerPort {
  on(event: "message", listener: (request: WorkerRequest) => void): void;
  postMessage(response: WorkerResponse, transfer?: ArrayBuffer[]): void;
}

export function pdfiumWorkerMain(
  port: WorkerPort,
  data: WorkerData,
  nodeRequire: (id: string) => unknown,
): void {
  const MAX_DOCUMENTS = 4;

  interface Page {
    getOriginalSize(): { originalWidth: number; originalHeight: number };
    render(options: { width: number; height: number; scale: number }): Promise<RenderResult>;
    close(): void;
  }
  interface Document {
    getPageCount(): number;
    getPage(index: number): Page;
    destroy(): void;
  }
  interface Library {
    loadDocument(bytes: Uint8Array, password?: string): Promise<Document>;
  }
  interface LibraryClass {
    init(options: {
      instantiateWasm(
        imports: object,
        done: (instance: object, module: WasmModule) => void,
      ): object;
    }): Promise<Library>;
  }
  interface WasmApi {
    instantiate(module: WasmModule, imports: object): Promise<object>;
    RuntimeError: new (...args: never[]) => Error;
  }
  const wasmApi = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;

  const loaded = { exports: {} as { PDFiumLibrary?: LibraryClass } };
  new Function("module", "exports", "require", "__dirname", "__filename", data.source)(
    loaded,
    loaded.exports,
    nodeRequire,
    "/",
    "/pdfium.cjs",
  );
  const PDFiumLibrary = loaded.exports.PDFiumLibrary;
  if (!PDFiumLibrary) throw new Error("The embedded PDFium build has no PDFiumLibrary.");

  const library = PDFiumLibrary.init({
    instantiateWasm(imports, done) {
      void wasmApi.instantiate(data.wasm, imports).then((instance) => done(instance, data.wasm));
      return {};
    },
  });

  /** Open documents by key, least recently used first. */
  const documents = new Map<string, { revision: string; document: Document }>();

  const remember = (key: string, revision: string, document: Document) => {
    const previous = documents.get(key);
    if (previous && previous.document !== document) previous.document.destroy();
    documents.delete(key);
    documents.set(key, { revision, document });
    while (documents.size > MAX_DOCUMENTS) {
      const [oldest, evicted] = documents.entries().next().value as [
        string,
        { document: Document },
      ];
      documents.delete(oldest);
      evicted.document.destroy();
    }
  };

  const failureOf = (error: unknown): WorkerFailure => {
    const message = error instanceof Error ? error.message : String(error);
    // Emscripten aborts throw RuntimeError and leave the module unusable.
    if (error instanceof wasmApi.RuntimeError) return { kind: "fatal", message };
    return { kind: "error", message };
  };

  const handle = async (request: WorkerRequest): Promise<void> => {
    const pdfium = await library;
    if (request.op === "open") {
      let document: Document;
      try {
        document = await pdfium.loadDocument(request.bytes, request.password);
      } catch (error) {
        if (error instanceof Error && /password/i.test(error.message)) {
          port.postMessage({ id: request.id, ok: false, failure: { kind: "password" } });
          return;
        }
        throw error;
      }
      const pages: OpenResult["pages"] = [];
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
      remember(request.key, request.revision, document);
      const value: OpenResult = { pages };
      port.postMessage({ id: request.id, ok: true, value });
      return;
    }

    const entry = documents.get(request.key);
    if (!entry || entry.revision !== request.revision) {
      port.postMessage({ id: request.id, ok: false, failure: { kind: "missing" } });
      return;
    }
    remember(request.key, entry.revision, entry.document);
    const page = entry.document.getPage(request.page);
    try {
      const bitmap = await page.render({ width: request.width, height: request.height, scale: 1 });
      const value: RenderResult = { width: bitmap.width, height: bitmap.height, data: bitmap.data };
      port.postMessage({ id: request.id, ok: true, value }, [bitmap.data.buffer as ArrayBuffer]);
    } finally {
      page.close();
    }
  };

  // The host sends one request at a time; the chain keeps them in order regardless.
  let queue = Promise.resolve();
  port.on("message", (request) => {
    queue = queue.then(() =>
      handle(request).catch((error: unknown) => {
        port.postMessage({ id: request.id, ok: false, failure: failureOf(error) });
      }),
    );
  });
}
