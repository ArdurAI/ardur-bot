import type { RuntimeCapabilityReport, RuntimeKind } from "@ardurbot/contracts";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

export function RuntimeCapabilityChecks({ kind }: { kind: RuntimeKind }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<RuntimeCapabilityReport | null>(null);
  useEffect(() => {
    setReport(null);
    if (!open) return;
    let active = true;
    void rpc.runtimes
      .capabilities({ runtimeKind: kind })
      .then((value) => {
        if (active) setReport(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [kind, open]);
  const names = {
    streaming: t`Streaming`,
    instructions: t`Instruction delivery`,
    cancellation: t`Cancellation`,
    "tool-authorization": t`Tool authorization`,
    usage: t`Usage`,
  };
  const visible = report?.runtimeKind === kind ? report : null;
  return (
    <details
      onToggle={(event) => {
        event.stopPropagation();
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="cursor-pointer text-sm text-muted-foreground">
        <Trans>Capability checks</Trans>
      </summary>
      {open ? (
        <div className="py-2 text-sm text-muted-foreground">
          {visible ? (
            <>
              <p>
                {visible.adapterId} · {visible.adapterVersion} ·{" "}
                {visible.runtimeVersion ?? t`Unknown`}
              </p>
              {visible.versionMismatch ? (
                <p>
                  <Trans>Report is for another version</Trans>
                </p>
              ) : null}
              <dl className="grid grid-cols-2 gap-2">
                {visible.checks.map((check) => (
                  <div key={check.behavior}>
                    <dt>{names[check.behavior]}</dt>
                    <dd>
                      {check.declared === true ? (
                        <>
                          <Trans>Declared</Trans> ·{" "}
                        </>
                      ) : null}
                      {check.verdict === "confirmed" ? (
                        <Trans>Confirmed offline</Trans>
                      ) : check.verdict === "unsupported" ? (
                        <Trans>Unsupported</Trans>
                      ) : (
                        <Trans>Not tested</Trans>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <p>
              <Trans>Not tested</Trans>
            </p>
          )}
        </div>
      ) : null}
    </details>
  );
}
