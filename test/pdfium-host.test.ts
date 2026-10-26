import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPdfiumHost, PdfiumError, type WorkerLike } from "../server/pdfium-host";
import type { WorkerRequest, WorkerResponse } from "../server/pdfium-worker";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

class FakeWorker implements WorkerLike {
  requests: WorkerRequest[] = [];
  terminated = false;
  private listeners = new Map<string, ((value: never) => void)[]>();

  postMessage(request: WorkerRequest) {
    this.requests.push(request);
  }

  on(event: string, listener: (value: never) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  terminate() {
    this.terminated = true;
    this.emit("exit", 1);
  }

  emit(event: "message" | "error" | "exit", value: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }

  reply(response: WorkerResponse) {
    this.emit("message", response);
  }

  last(): WorkerRequest {
    const request = this.requests.at(-1);
    if (!request) throw new Error("No request yet");
    return request;
  }
}

function setup(idleMs = 60_000) {
  const workers: FakeWorker[] = [];
  const log = vi.fn();
  const host = createPdfiumHost({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    idleMs,
    log,
  });
  return { host, workers, log };
}

const render = {
  op: "render",
  key: "/a.pdf",
  revision: "r1",
  page: 0,
  width: 10,
  height: 10,
} as const;

describe("createPdfiumHost", () => {
  it("sends one request at a time, in order", async () => {
    const { host, workers } = setup();
    const first = host.call(render, { timeoutMs: 1000 });
    const second = host.call({ ...render, page: 1 }, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    const [worker] = workers;
    expect(worker.requests).toHaveLength(1);
    worker.reply({ id: worker.last().id, ok: true, value: "one" });
    await expect(first).resolves.toBe("one");
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.requests).toHaveLength(2);
    expect(worker.last()).toMatchObject({ page: 1 });
    worker.reply({ id: worker.last().id, ok: true, value: "two" });
    await expect(second).resolves.toBe("two");
    expect(workers).toHaveLength(1);
  });

  it("maps worker failures to error kinds", async () => {
    const { host, workers } = setup();
    const missing = host.call(render, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    workers[0].reply({ id: workers[0].last().id, ok: false, failure: { kind: "missing" } });
    await expect(missing).rejects.toMatchObject({ kind: "missing" });

    const failed = host.call(render, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    workers[0].reply({
      id: workers[0].last().id,
      ok: false,
      failure: { kind: "error", message: "Page not found" },
    });
    await expect(failed).rejects.toMatchObject({ kind: "error", message: "Page not found" });
    expect(workers[0].terminated).toBe(false);
  });

  it("replaces a worker whose request runs past its deadline", async () => {
    const { host, workers } = setup();
    const slow = host.call(render, { timeoutMs: 500 });
    const next = host.call({ ...render, page: 2 }, { timeoutMs: 500 });
    const slowError = slow.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(await slowError).toBeInstanceOf(PdfiumError);
    expect(await slowError).toMatchObject({ kind: "timeout" });
    expect(workers[0].terminated).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    expect(workers[1].last()).toMatchObject({ page: 2 });
    workers[1].reply({ id: workers[1].last().id, ok: true, value: "after" });
    await expect(next).resolves.toBe("after");
  });

  it("ignores a late reply from a replaced worker", async () => {
    const { host, workers } = setup();
    const slow = host.call(render, { timeoutMs: 500 }).catch(() => "timed out");
    await vi.advanceTimersByTimeAsync(500);
    await expect(slow).resolves.toBe("timed out");
    const next = host.call(render, { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(0);
    // The old worker answers its own request late, with an id the new request may not share.
    workers[0].reply({ id: workers[0].requests[0].id, ok: true, value: "stale" });
    workers[1].reply({ id: workers[1].last().id, ok: true, value: "fresh" });
    await expect(next).resolves.toBe("fresh");
  });

  it("starts a new worker after PDFium aborts", async () => {
    const { host, workers, log } = setup();
    const aborted = host.call(render, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    workers[0].reply({
      id: workers[0].last().id,
      ok: false,
      failure: { kind: "fatal", message: "Aborted()" },
    });
    await expect(aborted).rejects.toMatchObject({ kind: "crashed" });
    expect(workers[0].terminated).toBe(true);
    expect(log).toHaveBeenCalled();

    const next = host.call(render, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    workers[1].reply({ id: workers[1].last().id, ok: true, value: "ok" });
    await expect(next).resolves.toBe("ok");
  });

  it("fails the running request when the worker exits", async () => {
    const { host, workers } = setup();
    const lost = host.call(render, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    workers[0].emit("exit", 134);
    await expect(lost).rejects.toMatchObject({ kind: "crashed" });

    const next = host.call(render, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    workers[1].reply({ id: workers[1].last().id, ok: true, value: "ok" });
    await expect(next).resolves.toBe("ok");
  });

  it("stops an idle worker and starts one for the next request", async () => {
    const { host, workers } = setup(1000);
    const first = host.call(render, { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(0);
    workers[0].reply({ id: workers[0].last().id, ok: true, value: 1 });
    await first;
    await vi.advanceTimersByTimeAsync(999);
    expect(workers[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0].terminated).toBe(true);

    void host.call(render, { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
  });

  it("rejects pending requests and stops the worker when disposed", async () => {
    const { host, workers } = setup();
    const running = host.call(render, { timeoutMs: 1000 }).catch((error: unknown) => error);
    const queued = host.call(render, { timeoutMs: 1000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    host.dispose();
    expect(await running).toMatchObject({ kind: "crashed" });
    expect(await queued).toMatchObject({ kind: "crashed" });
    expect(workers[0].terminated).toBe(true);
    await expect(host.call(render, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: "crashed" });
  });

  it("reports a worker that cannot start, and tries again for the next request", async () => {
    let attempts = 0;
    const host = createPdfiumHost({
      createWorker: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("no wasm");
        const worker = new FakeWorker();
        queueMicrotask(() => undefined);
        return worker;
      },
      log: () => {},
    });
    await expect(host.call(render, { timeoutMs: 1000 })).rejects.toMatchObject({ kind: "crashed" });
    void host.call(render, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
  });
});
