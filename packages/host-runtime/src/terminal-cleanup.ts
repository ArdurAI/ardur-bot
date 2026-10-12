// A stuck process tree must not hold shutdown or reconnection indefinitely.
export const TERMINAL_CLEANUP_DEADLINE_MS = 10_000;

/** Bounds the wait, not the work: late cleanup still owns its closing sessions. */
export async function waitForTerminalCleanup(
  cleanup: Promise<unknown> | undefined,
  onTimeout: () => void = () => {},
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          onTimeout();
          resolve();
        }, TERMINAL_CLEANUP_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
