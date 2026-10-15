import { RUN_STALLED_MESSAGE } from "@ardurbot/contracts";

/** A fixed step name is safe to log; never include a provider response or request. */
export class StepDeadlineExceeded extends Error {
  constructor(readonly step: string) {
    super(RUN_STALLED_MESSAGE);
    this.name = "StepDeadlineExceeded";
  }
}

/** Bound waiting even when an external adapter ignores cancellation. Does not cancel a commit. */
export async function beforeDeadline<T>(
  step: string,
  deadlineAt: number,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (Date.now() >= deadlineAt) throw new StepDeadlineExceeded(step);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepDeadlineExceeded(step)), deadlineAt - Date.now());
    timer.unref?.();
    abort = () => reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work(), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
