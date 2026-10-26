/**
 * The iOS panel's page renders. The panel hands over the pages it wants, most important first,
 * whenever the view moves or an image arrives; the queue runs at most `concurrency` at a time and
 * forgets queued pages that are no longer wanted. A fling past many pages therefore costs a couple
 * of renders, not one per page, and the daemon never sees a backlog.
 */
export interface RenderQueue<Job extends { key: string }> {
  /** Replaces the wanted jobs. Running jobs finish; queued jobs not in `jobs` are dropped. */
  want(jobs: readonly Job[]): void;
  /** Keys of the jobs running now. */
  running(): ReadonlySet<string>;
  dispose(): void;
}

export function createRenderQueue<Job extends { key: string }>(options: {
  run(job: Job): Promise<void>;
  concurrency?: number;
}): RenderQueue<Job> {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const active = new Set<string>();
  let queued: Job[] = [];
  let disposed = false;

  const pump = () => {
    while (!disposed && active.size < concurrency && queued.length > 0) {
      const job = queued.shift() as Job;
      if (active.has(job.key)) continue;
      active.add(job.key);
      void options
        .run(job)
        .catch(() => undefined)
        .then(() => {
          active.delete(job.key);
          pump();
        });
    }
  };

  return {
    want(jobs) {
      if (disposed) return;
      const seen = new Set<string>();
      queued = jobs.filter((job) => {
        if (active.has(job.key) || seen.has(job.key)) return false;
        seen.add(job.key);
        return true;
      });
      pump();
    },
    running: () => active,
    dispose() {
      disposed = true;
      queued = [];
    },
  };
}
