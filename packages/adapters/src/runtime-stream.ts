import type { AgentRuntimeEvent } from "@ardurbot/adapter-kit";

/** Cancel executor tool work before closing an interrupted runtime's iterator. */
export async function* withRuntimeCleanup(
  events: AsyncIterable<AgentRuntimeEvent>,
  controller: AbortController,
): AsyncIterable<AgentRuntimeEvent> {
  const iterator = events[Symbol.asyncIterator]();
  let complete = false;
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        complete = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!complete) {
      // for-await's implicit return() would otherwise run before the executor's
      // finally, potentially waiting on a tool whose signal is still live.
      controller.abort();
      await iterator.return?.();
    }
  }
}

/**
 * Reports `true` while its consumer waits on the runtime for the next event, and stays true once
 * the runtime has no more events. Its consumer asks only after handling every earlier event, so
 * a wait means everything the runtime emitted so far has been handled.
 */
export function reportRuntimeWaits<T>(
  events: AsyncIterable<T>,
  waiting: (value: boolean) => void,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = events[Symbol.asyncIterator]();
      return {
        async next() {
          waiting(true);
          const next = await iterator.next();
          if (!next.done) waiting(false);
          return next;
        },
        ...(iterator.return ? { return: (value?: unknown) => iterator.return!(value) } : {}),
        ...(iterator.throw ? { throw: (error?: unknown) => iterator.throw!(error) } : {}),
      };
    },
  };
}
