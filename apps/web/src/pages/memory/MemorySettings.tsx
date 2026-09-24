import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { lazy, useEffect, useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import type { SettingsPageProps } from "../settings-types";
import { MemoryPage } from "./MemoryPage";

const MemorySection = lazy(() => import("../settings/MemorySection"));

export default function MemorySettings(props: SettingsPageProps) {
  const spaceId = selectedSpaceId();
  return <MemorySettingsContent key={spaceId} {...props} spaceId={spaceId} />;
}

function MemorySettingsContent(props: SettingsPageProps & { spaceId: string | null }) {
  const { t } = useLingui();
  const [storage, setStorage] = useState(false);
  const [busy, setBusy] = useState(false);
  const { spaceId, onBusyChange } = props;
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  async function propose(intent: "import" | "edit", text: string) {
    setBusy(true);
    try {
      return await rpc.memory.propose(
        { intent, text, requestId: crypto.randomUUID() },
        { context: { spaceId } },
      );
    } finally {
      setBusy(false);
    }
  }
  if (storage)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="px-6 pt-2">
          <Button variant="ghost" disabled={busy} onClick={() => setStorage(false)}>
            <Trans>Back to memory</Trans>
          </Button>
        </div>
        <MemorySection {...props} onBusyChange={setBusy} />
      </div>
    );
  return (
    <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2">
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <SettingsRow label={t`Memory storage`}>
          <Button variant="outline" onClick={() => setStorage(true)}>
            <Trans>Manage</Trans>
          </Button>
        </SettingsRow>
        <MemoryPage
          proposeImport={(text) => propose("import", text)}
          proposeEdit={(text) => propose("edit", text)}
        />
      </fieldset>
    </div>
  );
}
