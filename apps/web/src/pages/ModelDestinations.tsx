import type { LocalityPolicy } from "@ardurbot/contracts";
import { rpcErrorMessage } from "@ardurbot/core";
import { Button, Input, NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { runSettingsMessage } from "../lib/use-can-run";

export function ModelDestinations({ botId }: { botId?: string }) {
  const id = useId();
  const { t } = useLingui();
  const [policy, setPolicy] = useState<LocalityPolicy | null>(null);
  const [hosts, setHosts] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [blockedNames, setBlockedNames] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void rpc.delegations
      .policy({ botId })
      .then((value) => {
        if (live) {
          setPolicy(value);
          setHosts(value.mode === "hosts" ? value.hosts.join(", ") : "");
        }
      })
      .catch(() => {
        if (live) setError(t`Could not save destinations; try again.`);
      });
    return () => {
      live = false;
    };
  }, [botId, t]);
  const save = async (next: LocalityPolicy) => {
    try {
      await rpc.delegations.setPolicy({ botId, policy: next });
      setPolicy(next);
      setError(null);
      setBlockedNames([]);
    } catch (cause) {
      const fallback = t`Could not save destinations; try again.`;
      const safe =
        cause &&
        typeof cause === "object" &&
        "message" in cause &&
        typeof cause.message === "string"
          ? {
              message: cause.message,
              code: "code" in cause && typeof cause.code === "string" ? cause.code : undefined,
            }
          : { message: fallback };
      setError(runSettingsMessage(rpcErrorMessage(safe, fallback)));
      const data = cause && typeof cause === "object" && "data" in cause ? cause.data : null;
      const bots =
        data && typeof data === "object" && "blockedBots" in data && Array.isArray(data.blockedBots)
          ? data.blockedBots
          : [];
      setBlockedNames(
        botId || safe.code !== "BAD_REQUEST"
          ? []
          : bots.flatMap((bot: unknown) =>
              bot && typeof bot === "object" && "name" in bot && typeof bot.name === "string"
                ? [bot.name]
                : [],
            ),
      );
    }
  };
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm">
        <Trans>Allowed model destinations</Trans>
      </label>
      <NativeSelect
        id={id}
        value={policy?.mode ?? "any"}
        disabled={!policy}
        onChange={(event) => {
          const mode = event.target.value as LocalityPolicy["mode"];
          if (mode === "hosts") setPolicy({ mode, hosts: [] });
          else void save({ mode });
        }}
      >
        <NativeSelectOption value="any">
          <Trans>Any</Trans>
        </NativeSelectOption>
        <NativeSelectOption value="local">
          <Trans>Local only</Trans>
        </NativeSelectOption>
        <NativeSelectOption value="hosts">
          <Trans>Listed hosts</Trans>
        </NativeSelectOption>
      </NativeSelect>
      {policy?.mode === "hosts" ? (
        <div className="flex gap-2">
          <Input
            aria-label={t`Allowed hosts`}
            value={hosts}
            onChange={(event) => setHosts(event.target.value)}
          />
          <Button
            variant="outline"
            onClick={() =>
              void save({
                mode: "hosts",
                hosts: hosts
                  .split(",")
                  .map((host) => host.trim())
                  .filter(Boolean),
              })
            }
          >
            <Trans>Save</Trans>
          </Button>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="text-xs text-destructive">
          <div>{error}</div>
          {blockedNames.length ? (
            <div>
              <Trans>Change these bots' models first: {blockedNames.join(", ")}</Trans>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
