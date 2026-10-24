export interface Throttled<Arg> {
  (arg: Arg): void;
  /** Runs a pending call now, for example before unmounting. */
  flush(): void;
  cancel(): void;
}

/** Calls `fn` at most once per `ms` with the latest argument, at the end of the interval. */
export function throttle<Arg>(fn: (arg: Arg) => void, ms: number): Throttled<Arg> {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let latest: { arg: Arg } | null = null;
  const fire = () => {
    handle = null;
    const call = latest;
    latest = null;
    if (call) fn(call.arg);
  };
  const throttled = ((arg: Arg) => {
    latest = { arg };
    handle ??= setTimeout(fire, ms);
  }) as Throttled<Arg>;
  throttled.flush = () => {
    if (handle !== null) clearTimeout(handle);
    fire();
  };
  throttled.cancel = () => {
    if (handle !== null) clearTimeout(handle);
    handle = null;
    latest = null;
  };
  return throttled;
}
