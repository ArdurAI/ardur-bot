import type { CapabilityPreferences, ComputerNetworkSetting } from "@ardurbot/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  NativeSelect,
  NativeSelectOption,
  Switch,
} from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useRef, useState } from "react";

export type { CapabilityPreferences, ComputerNetworkSetting } from "@ardurbot/contracts";

export function CapabilitiesPage({
  settings,
  canConfigure,
  computers,
  unsupportedRuntimes,
  onChange,
  onNetworkChange,
  onOpenComputers,
  onOpenCustomize,
}: {
  settings: CapabilityPreferences;
  canConfigure: boolean;
  computers: ComputerNetworkSetting[];
  unsupportedRuntimes: string[];
  onChange: (patch: Partial<CapabilityPreferences>) => Promise<void>;
  onNetworkChange: (computerId: string, networkEgress: boolean, confirmed: true) => Promise<void>;
  onOpenComputers: () => void;
  onOpenCustomize: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkChange, setNetworkChange] = useState<{
    computerId: string;
    networkEgress: boolean;
  } | null>(null);
  const disabled = busy || !canConfigure;

  async function change(work: () => Promise<void>, network = false) {
    if (locked.current || !canConfigure) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      if (network) setNetworkChange(null);
    } catch {
      setError(
        network
          ? t`Could not change the computer. Stop its bots and try again.`
          : t`Could not save capabilities. Try again.`,
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="capabilities-settings">
      <section aria-label={t`General`} className="divide-y divide-border">
        <h3 className="pb-2 text-sm font-medium">
          <Trans>General</Trans>
        </h3>
        <div className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="min-w-0 flex-1">
            <label htmlFor={`${id}-tools`} className="text-sm font-medium">
              <Trans>Tool access mode</Trans>
            </label>
            <p id={`${id}-tools-help`} className="mt-1 text-sm text-muted-foreground">
              <Trans>Controls how connector tools are loaded in new conversations.</Trans>
            </p>
            {unsupportedRuntimes.map((runtime) => (
              <p key={runtime} className="mt-1 text-sm text-muted-foreground">
                <Trans>
                  {runtime} loads all connected tools because deferred loading is unavailable.
                </Trans>
              </p>
            ))}
          </div>
          <NativeSelect
            id={`${id}-tools`}
            aria-describedby={`${id}-tools-help`}
            disabled={disabled}
            value={settings.toolAccessMode}
            onChange={(event) => {
              const toolAccessMode = event.target.value;
              if (toolAccessMode === "all" || toolAccessMode === "when-needed")
                void change(() => onChange({ toolAccessMode }));
            }}
          >
            <NativeSelectOption value="when-needed">
              <Trans>Load tools when needed</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="all">
              <Trans>Load all connected tools</Trans>
            </NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="flex items-center justify-between gap-4 py-4">
          <div>
            <label htmlFor={`${id}-search`} className="text-sm font-medium">
              <Trans>Connector search</Trans>
            </label>
            <p id={`${id}-search-help`} className="mt-1 text-sm text-muted-foreground">
              <Trans>
                Let the assistant search the connector directory and surface ones relevant to your
                conversation.
              </Trans>
            </p>
          </div>
          <Switch
            id={`${id}-search`}
            aria-label={t`Connector search`}
            aria-describedby={`${id}-search-help`}
            checked={settings.connectorSearch}
            disabled={disabled}
            onCheckedChange={(connectorSearch) => void change(() => onChange({ connectorSearch }))}
          />
        </div>
      </section>
      <section aria-label={t`Visuals`}>
        <h3 className="text-sm font-medium">
          <Trans>Visuals</Trans>
        </h3>
        <div className="flex items-center justify-between gap-4 py-4">
          <div>
            <label htmlFor={`${id}-visuals`} className="text-sm font-medium">
              <Trans>Inline visualizations</Trans>
            </label>
            <p className="mt-1 text-sm text-muted-foreground">
              <Trans>
                Interactive visualizations, charts, and diagrams directly in the conversation.
              </Trans>
            </p>
          </div>
          <Switch
            id={`${id}-visuals`}
            aria-label={t`Inline visualizations`}
            checked={settings.inlineVisualizations}
            disabled={disabled}
            onCheckedChange={(inlineVisualizations) =>
              void change(() => onChange({ inlineVisualizations }))
            }
          />
        </div>
      </section>
      <section aria-label={t`Code execution on computers`} className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-sm font-medium">
            <Trans>Code execution on computers</Trans>
          </h3>
          <Button variant="ghost" onClick={onOpenComputers}>
            <Trans>Computers</Trans>
          </Button>
        </div>
        <p id={`${id}-egress-help`} className="text-sm text-muted-foreground">
          <Trans>
            Network access lets a bot install packages and reach the internet. This comes with
            security risks.
          </Trans>
        </p>
        {computers.map((computer) => (
          <div
            key={computer.id}
            className="flex items-center justify-between gap-4 border-t border-border py-3"
          >
            <div>
              <p className="text-sm font-medium">{computer.name}</p>
              <label htmlFor={`${id}-${computer.id}`} className="text-sm text-muted-foreground">
                <Trans>Allow network egress</Trans>
                <span className="sr-only">
                  {" "}
                  <Trans>for {computer.name}</Trans>
                </span>
              </label>
              {!computer.supported ? (
                <p className="text-sm text-muted-foreground">
                  {computer.kind === "kubernetes"
                    ? t`Unsupported: no verified NetworkPolicy controller.`
                    : t`Network control is unavailable on this computer.`}
                </p>
              ) : null}
              {computer.pending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  <Trans>Computer change pending.</Trans>
                </p>
              ) : null}
            </div>
            <Switch
              id={`${id}-${computer.id}`}
              aria-label={t`Allow network egress for ${computer.name}`}
              aria-describedby={`${id}-egress-help`}
              checked={computer.networkEgress}
              disabled={disabled || !computer.supported || computer.pending}
              onCheckedChange={(networkEgress) =>
                setNetworkChange({ computerId: computer.id, networkEgress })
              }
            />
          </div>
        ))}
      </section>
      <section aria-label={t`Skills`} className="border-t border-border pt-3">
        <Button variant="ghost" onClick={onOpenCustomize}>
          <Trans>Skills have moved to Customize</Trans>
        </Button>
      </section>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <AlertDialog
        open={!!networkChange}
        onOpenChange={(open) => {
          if (!open && !busy) setNetworkChange(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Change computer</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>This replaces the computer's files. Continue?</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={disabled || !networkChange}
              onClick={(event) => {
                event.preventDefault();
                if (networkChange)
                  void change(
                    () =>
                      onNetworkChange(networkChange.computerId, networkChange.networkEgress, true),
                    true,
                  );
              }}
            >
              <Trans>Continue</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
