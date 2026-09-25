import type { SpaceFeatureEntry } from "@ardurbot/contracts";
import { Trans } from "@lingui/react/macro";
import governanceDoc from "../../../../../docs/governance.md?url";
import { rpc } from "../../lib/rpc";
import type { PanelContext } from "./panels";

export async function load(context: PanelContext) {
  const features = await rpc.features.list(undefined, {
    signal: context.signal,
    context: { spaceId: context.spaceId },
  });
  const governance = features.find((entry) => entry.feature === "governance");
  if (!governance) throw new Error("Missing governance availability");
  return governance;
}
export default function GovernancePanel({ data: _feature }: { data: SpaceFeatureEntry }) {
  // Even a stale enabled row cannot advertise absent governance or encryption.
  return (
    <p className="text-sm text-muted-foreground">
      <a
        className="underline underline-offset-4"
        href={governanceDoc}
        target="_blank"
        rel="noreferrer"
      >
        <Trans>Governance and encryption are not part of this build yet.</Trans>
      </a>
    </p>
  );
}
