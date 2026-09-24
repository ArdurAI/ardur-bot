import { Switch } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc, selectedSpaceId } from "../../lib/rpc";

export function DispatchSetting() {
  const { t } = useLingui();
  const [spaceId] = useState(selectedSpaceId);
  const [value, setValue] = useState<{ enabled: boolean; canChange: boolean } | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void rpc.system
      .dispatch(undefined, { context: { spaceId } })
      .then((next) => {
        if (active) setValue(next);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [spaceId]);
  return (
    <section className="border-b border-border py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <label htmlFor="system-dispatch" className="text-sm font-medium">{t`Dispatch`}</label>
          <span className="ms-2 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">{t`Beta`}</span>
          <p
            id="system-dispatch-description"
            className="mt-1 text-sm text-muted-foreground"
          >{t`Let paired phones and chat accounts dispatch, steer, and approve work in this space.`}</p>
        </div>
        {value ? (
          <Switch
            id="system-dispatch"
            aria-describedby="system-dispatch-description"
            checked={value.enabled}
            disabled={busy || !value.canChange}
            onCheckedChange={(enabled) => {
              setBusy(true);
              setError(false);
              void rpc.system
                .setDispatch({ enabled }, { context: { spaceId } })
                .then(setValue)
                .catch(() => setError(true))
                .finally(() => setBusy(false));
            }}
          />
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-2 text-sm text-destructive"
        >{t`Could not read or change Dispatch; reopen System settings.`}</p>
      ) : null}
    </section>
  );
}
