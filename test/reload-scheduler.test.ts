import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReloadScheduler, type ReloadState } from "../client/reload-scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createReloadScheduler", () => {
  it("reloads once after a burst of changes settles", async () => {
    const run = vi.fn(async () => {});
    const scheduler = createReloadScheduler({ run, onState: () => {}, settleMs: 400 });
    scheduler.request();
    await vi.advanceTimersByTimeAsync(200);
    scheduler.request();
    await vi.advanceTimersByTimeAsync(200);
    scheduler.request();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs an immediate request without waiting", async () => {
    const run = vi.fn(async () => {});
    const scheduler = createReloadScheduler({ run, onState: () => {} });
    scheduler.request(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("queues one more reload for changes that arrive during a reload", async () => {
    const first = deferred();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const scheduler = createReloadScheduler({ run, onState: () => {}, settleMs: 100 });
    scheduler.request(true);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.request();
    scheduler.request();
    first.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("retries a failed reload, then reports failure until the next change", async () => {
    const states: ReloadState[] = [];
    const run = vi.fn<() => Promise<void>>(async () => {
      throw new Error("Invalid PDF structure.");
    });
    const scheduler = createReloadScheduler({
      run,
      onState: (state) => states.push(state),
      retryMs: 1000,
      maxRetries: 2,
    });
    scheduler.request(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(states.at(-1)).toBe("failed");
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(3);

    run.mockResolvedValueOnce(undefined);
    scheduler.request(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(4);
    expect(states.at(-1)).toBe("idle");
  });

  it("does nothing after disposal", async () => {
    const run = vi.fn(async () => {});
    const scheduler = createReloadScheduler({ run, onState: () => {} });
    scheduler.request();
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
  });
});
