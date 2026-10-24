/**
 * Turns a burst of "the file changed" events into one reload of the settled file.
 *
 * Compilers often write a PDF in several steps (truncate, write, rename), and each step can arrive
 * as a change. Reading mid-write yields a broken PDF, and every read is a full download over the
 * relay, so wait for the file to settle, run one reload at a time, and retry a failed reload a few
 * times before giving up until the next change.
 */
export type ReloadState = "idle" | "waiting" | "loading" | "failed";

export interface ReloadSchedulerOptions {
  run: () => Promise<void>;
  onState: (state: ReloadState, error?: unknown) => void;
  settleMs?: number;
  retryMs?: number;
  maxRetries?: number;
  timers?: {
    setTimeout: (callback: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export interface ReloadScheduler {
  /**
   * A change was seen; reload once the file has been quiet for the settle time. `immediate` skips
   * the wait, for the first load and an explicit retry.
   */
  request(immediate?: boolean): void;
  dispose(): void;
}

export function createReloadScheduler(options: ReloadSchedulerOptions): ReloadScheduler {
  const settleMs = options.settleMs ?? 400;
  const retryMs = options.retryMs ?? 1500;
  const maxRetries = options.maxRetries ?? 3;
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let timer: unknown = null;
  let running = false;
  let pending = false;
  let retries = 0;
  let disposed = false;

  const schedule = (ms: number) => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      void start();
    }, ms);
  };

  const start = async () => {
    if (disposed) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    pending = false;
    options.onState("loading");
    try {
      await options.run();
      if (disposed) return;
      retries = 0;
      options.onState("idle");
    } catch (error) {
      if (disposed) return;
      if (!pending && retries < maxRetries) {
        retries += 1;
        options.onState("waiting", error);
        schedule(retryMs);
      } else if (!pending) {
        options.onState("failed", error);
      }
    } finally {
      running = false;
    }
    if (pending && !disposed) {
      pending = false;
      schedule(settleMs);
    }
  };

  return {
    request(immediate = false) {
      if (disposed) return;
      retries = 0;
      if (running) {
        pending = true;
        return;
      }
      options.onState("waiting");
      schedule(immediate ? 0 : settleMs);
    },
    dispose() {
      disposed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}
