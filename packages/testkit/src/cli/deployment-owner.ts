type OwnerSession = { userId: string; sessionId: string };

// The 360 s bot-comms spec renews every 60 s; a silent holder expires after 180 s.
export const DEPLOYMENT_OWNER_LEASE_MS = 180_000;
export const DEPLOYMENT_OWNER_RENEW_MS = 60_000;

export function createDeploymentOwnerFixture(options: {
  authenticate: (request: Request) => Promise<OwnerSession | null>;
  setOwner: (userId: string) => Promise<void>;
  waitMs?: number;
  leaseMs?: number;
}) {
  const waitMs = options.waitMs ?? 120_000;
  const leaseMs = options.leaseMs ?? DEPLOYMENT_OWNER_LEASE_MS;
  let lease: { sessionId: string; expiresAt: number } | undefined;
  const waiters = new Set<() => void>();
  const wakeWaiters = () => {
    for (const wake of waiters) wake();
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST" && request.method !== "DELETE") {
      return new Response(null, { status: 405 });
    }
    const session = await options.authenticate(request);
    if (!session) return new Response(null, { status: 401 });

    if (request.method === "DELETE") {
      if (lease?.sessionId !== session.sessionId) return new Response(null, { status: 403 });
      lease = undefined;
      wakeWaiters();
      return new Response(null, { status: 204 });
    }

    const deadline = Date.now() + waitMs;
    for (;;) {
      if (request.signal.aborted) throw new DOMException("Ownership claim aborted", "AbortError");
      const now = Date.now();
      if (lease && lease.expiresAt <= now) {
        lease = undefined;
        wakeWaiters();
      }
      if (!lease || lease.sessionId === session.sessionId) {
        const previous = lease;
        const claimedLease = { sessionId: session.sessionId, expiresAt: now + leaseMs };
        lease = claimedLease;
        try {
          await options.setOwner(session.userId);
          if (request.signal.aborted) {
            throw new DOMException("Ownership claim aborted", "AbortError");
          }
        } catch (error) {
          if (lease === claimedLease) {
            lease = previous;
            if (!previous) wakeWaiters();
          }
          throw error;
        }
        return Response.json({ ok: true });
      }
      const remaining = Math.min(deadline - now, lease.expiresAt - now);
      if (remaining <= 0) return new Response(null, { status: 423 });
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          request.signal.removeEventListener("abort", abort);
        };
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(new DOMException("Ownership claim aborted", "AbortError"));
        };
        const timer = setTimeout(wake, remaining);
        waiters.add(wake);
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      });
    }
  };
}
