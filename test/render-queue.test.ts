import { describe, expect, it } from "vitest";
import { createRenderQueue } from "../client/render-queue";

interface Job {
  key: string;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(concurrency = 2) {
  const started: string[] = [];
  const pending = new Map<string, ReturnType<typeof deferred>>();
  const queue = createRenderQueue<Job>({
    concurrency,
    run: (job) => {
      started.push(job.key);
      const done = deferred();
      pending.set(job.key, done);
      return done.promise;
    },
  });
  const settle = async (key: string, fail = false) => {
    const done = pending.get(key);
    if (!done) throw new Error(`${key} is not running`);
    if (fail) done.reject(new Error("render failed"));
    else done.resolve();
    // Let the queue's continuation run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { queue, started, settle };
}

const jobs = (...keys: string[]) => keys.map((key) => ({ key }));

describe("createRenderQueue", () => {
  it("runs the most wanted jobs first, at most `concurrency` at a time", async () => {
    const { queue, started, settle } = setup(2);
    queue.want(jobs("a", "b", "c", "d"));
    expect(started).toEqual(["a", "b"]);
    await settle("a");
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("drops queued jobs that are no longer wanted", async () => {
    const { queue, started, settle } = setup(1);
    queue.want(jobs("p1", "p2", "p3"));
    // A fling: the view is now far away.
    queue.want(jobs("p40", "p41"));
    await settle("p1");
    await settle("p40");
    expect(started).toEqual(["p1", "p40", "p41"]);
  });

  it("does not start a job twice while it runs", async () => {
    const { queue, started, settle } = setup(2);
    queue.want(jobs("a"));
    queue.want(jobs("a", "b"));
    queue.want(jobs("a", "b", "b"));
    expect(started).toEqual(["a", "b"]);
    expect([...queue.running()].sort()).toEqual(["a", "b"]);
    await settle("a");
    expect([...queue.running()]).toEqual(["b"]);
  });

  it("carries on after a job fails", async () => {
    const { queue, started, settle } = setup(1);
    queue.want(jobs("a", "b"));
    await settle("a", true);
    expect(started).toEqual(["a", "b"]);
  });

  it("starts nothing after dispose", async () => {
    const { queue, started, settle } = setup(1);
    queue.want(jobs("a", "b"));
    queue.dispose();
    await settle("a");
    queue.want(jobs("c"));
    expect(started).toEqual(["a"]);
  });
});
