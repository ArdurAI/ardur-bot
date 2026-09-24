import type { LearningProposal, SpaceLearningConfig } from "@ardurbot/contracts";
import { Button, Skeleton } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import type { CategorizedMemoryDocument } from "./document-groups";
import { MemoryComposer } from "./MemoryComposer";
import { MemoryDocuments } from "./MemoryDocuments";
import { MemoryGeneration } from "./MemoryGeneration";
import { MemoryImport } from "./MemoryImport";
import { MemoryProposals } from "./MemoryProposals";

type MemoryPageProps = {
  proposeImport: (text: string) => Promise<LearningProposal[]>;
  proposeEdit: (instruction: string) => Promise<LearningProposal[]>;
};

export function MemoryPage(props: MemoryPageProps) {
  const spaceId = selectedSpaceId();
  return <MemoryPageContent key={spaceId} {...props} spaceId={spaceId} />;
}

function MemoryPageContent({
  proposeImport,
  proposeEdit,
  spaceId,
}: MemoryPageProps & { spaceId: string | null }) {
  const [documents, setDocuments] = useState<CategorizedMemoryDocument[]>([]);
  const [settings, setSettings] = useState<SpaceLearningConfig | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [proposals, setProposals] = useState<LearningProposal[]>([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const [page, settings, inbox] = await Promise.all([
      rpc.memory.list({ scope: "user" }, { context: { spaceId } }),
      rpc.learning.settings(undefined, { context: { spaceId } }),
      rpc.learning.list({}, { context: { spaceId } }),
    ]);
    if (current !== generation.current) return;
    setDocuments(page.items);
    setCursor(page.nextCursor);
    setSettings(settings);
    setProposals(inbox.proposals.filter((proposal) => proposal.type === "memory"));
    setError(false);
  }, [spaceId]);
  useEffect(() => {
    setSettings(null);
    setDocuments([]);
    setProposals([]);
    void refresh().catch(() => setError(true));
    return () => {
      generation.current++;
    };
  }, [refresh]);

  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    const current = generation.current;
    try {
      const page = await rpc.memory.list({ scope: "user", cursor }, { context: { spaceId } });
      if (current !== generation.current) return;
      setDocuments((items) => [...items, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      setBusy(false);
    }
  }

  function receive(incoming: LearningProposal[]) {
    setProposals((current) => [
      ...incoming,
      ...current.filter((item) => !incoming.some((next) => next.id === item.id)),
    ]);
  }

  return (
    <div className="space-y-6" data-testid="memory-settings-page">
      {error ? (
        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
          <Trans>Could not load memory.</Trans>
          <Button variant="outline" onClick={() => void refresh().catch(() => setError(true))}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {!settings && !error ? <Skeleton className="h-24 w-full" /> : null}
      {settings ? (
        <>
          <MemoryGeneration settings={settings} onChange={setSettings} />
          <MemoryImport propose={proposeImport} onProposals={receive} />
          <MemoryDocuments
            documents={documents}
            onChange={(updated) =>
              setDocuments((current) =>
                current.map((item) => (item.id === updated.id ? updated : item)),
              )
            }
          />
          {cursor ? (
            <Button variant="ghost" disabled={busy} onClick={() => void more()}>
              <Trans>More memory</Trans>
            </Button>
          ) : null}
          <MemoryProposals
            proposals={proposals}
            onChange={(updated) => {
              setProposals((current) =>
                current.map((item) => (item.id === updated.id ? updated : item)),
              );
              if (updated.status === "applied" || updated.status === "reverted")
                void refresh().catch(() => setError(true));
            }}
          />
          <MemoryComposer propose={proposeEdit} onProposals={receive} />
        </>
      ) : null}
    </div>
  );
}
