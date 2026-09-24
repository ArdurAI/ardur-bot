import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function MemoryDeliveryProgress() {
  const [progress, setProgress] = useState<{
    total: number;
    delivered: number;
    pending: number;
    failed: number;
  } | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await rpc.memory.deliveryProgress();
        if (active) setProgress(next);
      } catch {
        /* Keep the last confirmed count during a connection outage. */
      }
      if (active) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  if (!progress || !progress.total) return null;
  const { delivered, total, failed } = progress;
  return (
    <p role="status" className="mt-2 text-sm text-muted-foreground">
      <Trans>
        Indexed {delivered} of {total}
      </Trans>
      {failed ? (
        <>
          {" "}
          · <Trans>{failed} failed</Trans>
        </>
      ) : null}
    </p>
  );
}
