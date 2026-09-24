/** Stop latency is bounded by this interval plus the database round trip. */
export const EXECUTION_TICK_MS = 5_000;
export const LEASE_RENEWAL_MS = 60_000;

/** One non-overlapping timer per active run; no timer exists once execution ends. */
export function startExecutionHeartbeat({
  checkStop,
  renew,
  onFailure,
}: {
  checkStop: () => Promise<void>;
  renew: () => Promise<void>;
  onFailure: () => void;
}): () => void {
  let lastRenewal = Date.now();
  let pending = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = true;
    const renewalDue = Date.now() - lastRenewal >= LEASE_RENEWAL_MS;
    void Promise.all([checkStop(), ...(renewalDue ? [renew()] : [])])
      .then(() => {
        if (renewalDue) lastRenewal = Date.now();
      })
      .catch(() => {
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
          onFailure();
        }
      })
      .finally(() => {
        pending = false;
      });
  }, EXECUTION_TICK_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
