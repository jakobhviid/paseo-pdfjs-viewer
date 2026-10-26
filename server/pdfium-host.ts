import type { WorkerFailure, WorkerRequest, WorkerResponse } from "./pdfium-worker";

// Runs PDFium in one worker thread. Rendering is synchronous wasm, so on the plugin's own thread a
// heavy page would hold up every other request, PDF.js asset requests from desktop and web
// included, and an aborted PDFium would stay broken. Here requests go to the worker one at a time,
// each with a deadline. A request that runs past it, a worker that crashes, or a PDFium abort
// replaces the worker; the next request starts a fresh one, and documents are opened again on
// demand. An idle worker is stopped, which frees the documents it held.

export interface WorkerLike {
  postMessage(request: WorkerRequest, transfer?: ArrayBuffer[]): void;
  on(event: "message", listener: (response: WorkerResponse) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  terminate(): unknown;
}

export type PdfiumErrorKind = "password" | "missing" | "error" | "timeout" | "crashed";

export class PdfiumError extends Error {
  constructor(
    readonly kind: PdfiumErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PdfiumError";
  }
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PdfiumHostOptions {
  createWorker(): WorkerLike | Promise<WorkerLike>;
  /** How long a worker may sit unused before it is stopped. */
  idleMs?: number;
  timers?: Timers;
  log?: (message: string) => void;
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
/** A request without its id; the host numbers requests. */
export type HostRequest = WithoutId<WorkerRequest>;

export interface PdfiumHost {
  call(
    request: HostRequest,
    options: { timeoutMs: number; transfer?: ArrayBuffer[] },
  ): Promise<unknown>;
  dispose(): void;
}

interface Job {
  id: number;
  request: HostRequest;
  timeoutMs: number;
  transfer?: ArrayBuffer[];
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Running {
  job: Job;
  worker: WorkerLike | null;
  timer: unknown;
}

const MESSAGES: Record<Exclude<WorkerFailure["kind"], "error" | "fatal">, string> = {
  password: "The PDF needs a password.",
  missing: "The PDF is no longer open.",
};

export function createPdfiumHost(options: PdfiumHostOptions): PdfiumHost {
  const idleMs = options.idleMs ?? 60_000;
  const timers: Timers = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const log = options.log ?? ((message) => console.error(`[pdfjs-viewer] ${message}`));

  const queue: Job[] = [];
  /** The request with the worker; `worker` is null while the worker starts. */
  let running: Running | null = null;
  let worker: WorkerLike | null = null;
  let starting: Promise<WorkerLike> | null = null;
  let idleTimer: unknown = null;
  let nextId = 1;
  let disposed = false;

  /** Workers this host stopped on purpose; their exit is not a crash. */
  const retired = new WeakSet<WorkerLike>();

  const stop = (target: WorkerLike | null) => {
    if (!target) return;
    retired.add(target);
    if (worker === target) worker = null;
    try {
      void target.terminate();
    } catch {
      // Already gone.
    }
  };

  const finish = (outcome: { value: unknown } | { error: Error }) => {
    const current = running;
    if (!current) return;
    running = null;
    timers.clearTimeout(current.timer);
    if ("error" in outcome) current.job.reject(outcome.error);
    else current.job.resolve(outcome.value);
    void pump();
  };

  const attach = (created: WorkerLike) => {
    created.on("message", (response) => {
      if (!running || running.worker !== created || running.job.id !== response.id) return;
      if (response.ok) return finish({ value: response.value });
      const { failure } = response;
      if (failure.kind === "fatal") {
        log(`PDFium aborted; starting a new worker. ${failure.message}`);
        stop(created);
        return finish({
          error: new PdfiumError("crashed", "The PDF renderer failed on this file."),
        });
      }
      const message = failure.kind === "error" ? failure.message : MESSAGES[failure.kind];
      finish({ error: new PdfiumError(failure.kind, message) });
    });
    const lost = (reason: string) => {
      if (retired.has(created)) return;
      retired.add(created);
      log(`The PDFium worker stopped: ${reason}`);
      if (worker === created) worker = null;
      if (running?.worker === created) {
        finish({ error: new PdfiumError("crashed", "The PDF renderer stopped unexpectedly.") });
      }
    };
    created.on("error", (error) => lost(error.message));
    created.on("exit", (code) => lost(`exit code ${code}`));
  };

  const ensureWorker = async (): Promise<WorkerLike> => {
    if (worker) return worker;
    starting ??= Promise.resolve(options.createWorker()).then(
      (created) => {
        starting = null;
        attach(created);
        worker = created;
        return created;
      },
      (error: unknown) => {
        starting = null;
        throw error;
      },
    );
    return starting;
  };

  const scheduleIdle = () => {
    if (idleTimer !== null) timers.clearTimeout(idleTimer);
    idleTimer = timers.setTimeout(() => {
      idleTimer = null;
      if (!running && queue.length === 0) stop(worker);
    }, idleMs);
  };

  async function pump(): Promise<void> {
    if (disposed || running || queue.length === 0) {
      if (!running && queue.length === 0 && worker) scheduleIdle();
      return;
    }
    const job = queue.shift() as Job;
    // Claimed before the worker starts, so a request arriving meanwhile waits its turn.
    const slot: Running = { job, worker: null, timer: null };
    running = slot;
    let target: WorkerLike;
    try {
      target = await ensureWorker();
    } catch (error) {
      if (running !== slot) return;
      running = null;
      job.reject(
        new PdfiumError("crashed", `The PDF renderer could not start: ${messageOf(error)}`),
      );
      return pump();
    }
    // Disposed while the worker started; dispose rejected the job.
    if (running !== slot) return;
    slot.worker = target;
    slot.timer = timers.setTimeout(() => {
      if (running !== slot) return;
      log(`A ${job.request.op} request ran past ${job.timeoutMs} ms; starting a new worker.`);
      stop(target);
      finish({ error: new PdfiumError("timeout", "The PDF took too long to render.") });
    }, job.timeoutMs);
    try {
      target.postMessage({ ...job.request, id: job.id } as WorkerRequest, job.transfer);
    } catch (error) {
      finish({ error: new PdfiumError("error", messageOf(error)) });
    }
  }

  return {
    call(request, { timeoutMs, transfer }) {
      if (disposed)
        return Promise.reject(new PdfiumError("crashed", "The PDF renderer was stopped."));
      if (idleTimer !== null) {
        timers.clearTimeout(idleTimer);
        idleTimer = null;
      }
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, request, timeoutMs, transfer, resolve, reject });
        void pump();
      });
    },
    dispose() {
      disposed = true;
      if (idleTimer !== null) timers.clearTimeout(idleTimer);
      const stopped = new PdfiumError("crashed", "The PDF renderer was stopped.");
      for (const job of queue.splice(0)) job.reject(stopped);
      if (running) {
        timers.clearTimeout(running.timer);
        running.job.reject(stopped);
        running = null;
      }
      stop(worker);
      void starting?.then(stop, () => undefined);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
