import type { AgentRuntimeEvent } from "@ardurbot/adapter-kit";

/**
 * Cancel executor tool work before closing an interrupted runtime's iterator.
 * `waiting` reports while the consumer waits on the runtime for its next event, and stays true
 * once the runtime has no more events.
 */
export async function* withRuntimeCleanup(
  events: AsyncIterable<AgentRuntimeEvent>,
  controller: AbortController,
  waiting: (value: boolean) => void = () => {},
): AsyncIterable<AgentRuntimeEvent> {
  const iterator = events[Symbol.asyncIterator]();
  let complete = false;
  try {
    while (true) {
      waiting(true);
      const next = await iterator.next();
      if (next.done) {
        complete = true;
        return;
      }
      waiting(false);
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
