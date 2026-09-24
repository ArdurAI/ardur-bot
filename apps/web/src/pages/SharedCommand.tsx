import type { CommandBlock } from "@ardurbot/contracts";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { Navigate, useLocation, useParams, useSearchParams } from "react-router-dom";
import { ThreadCommandBlock } from "../components/ThreadCommandBlock";
import { rpc } from "../lib/rpc";

export function SharedCommandPage() {
  const { t } = useLingui();
  const { runId = "", commandId = "" } = useParams();
  const [params] = useSearchParams();
  const spaceId = params.get("space") ?? undefined;
  const [block, setBlock] = useState<CommandBlock | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setBlock(null);
    setDenied(false);
    void rpc.commands.open({ runId, commandId }, { context: { spaceId } }).then(
      (value) => {
        if (!cancelled) setBlock(value);
      },
      () => {
        if (!cancelled) setDenied(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runId, commandId, spaceId]);
  return (
    <main className="mx-auto max-w-3xl p-6">
      {block ? (
        <ThreadCommandBlock block={block} spaceId={spaceId} />
      ) : (
        <p role="status">
          {denied ? t`This command is not available to this account.` : t`Loading…`}
        </p>
      )}
    </main>
  );
}

export function SharedCommandSignIn() {
  const location = useLocation();
  return (
    <Navigate
      to={`/sign-in?${new URLSearchParams({ next: location.pathname + location.search })}`}
      replace
    />
  );
}
