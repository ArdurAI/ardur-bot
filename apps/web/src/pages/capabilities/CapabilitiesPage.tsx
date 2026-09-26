import type { CapabilityPreferences, ComputerNetworkSetting } from "@ardurbot/contracts";
import { computerRefusalMessage } from "@ardurbot/core";
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
import { useEffect, useRef, useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";

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
  onBusyChange,
}: {
  settings: CapabilityPreferences;
  canConfigure: boolean;
  computers: ComputerNetworkSetting[];
  unsupportedRuntimes: string[];
  onChange: (patch: Partial<CapabilityPreferences>) => Promise<void>;
  onNetworkChange: (computerId: string, networkEgress: boolean, confirmed: true) => Promise<void>;
  onOpenComputers: () => void;
  onOpenCustomize: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkChange, setNetworkChange] = useState<{
    computerId: string;
    networkEgress: boolean;
  } | null>(null);
  const disabled = busy || !canConfigure;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  async function change(work: () => Promise<void>, network = false) {
    if (locked.current || !canConfigure) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      if (network) setNetworkChange(null);
    } catch (caught: unknown) {
      setError(
        computerRefusalMessage(
          caught,
          network
            ? t`Could not change the computer. Stop its bots and try again.`
            : t`Could not save capabilities. Try again.`,
        ),
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="capabilities-settings">
      <section aria-label={t`General`}>
        <h3 className="text-sm font-medium">
          <Trans>General</Trans>
        </h3>
        <SettingsRow
          label={t`Tool access mode`}
          description={t`Controls how connector tools are loaded in new conversations.`}
          content={unsupportedRuntimes.map((runtime) => (
            <p key={runtime} className="mt-1 text-sm text-muted-foreground">
              <Trans>
                {runtime} loads all connected tools because deferred loading is unavailable.
              </Trans>
            </p>
          ))}
        >
          <NativeSelect
            aria-label={t`Tool access mode`}
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
        </SettingsRow>
        <SettingsRow
          label={t`Connector search`}
          description={t`Let the assistant search the connector directory and surface ones relevant to your conversation.`}
        >
          <Switch
            aria-label={t`Connector search`}
            checked={settings.connectorSearch}
            disabled={disabled}
            onCheckedChange={(connectorSearch) => void change(() => onChange({ connectorSearch }))}
          />
        </SettingsRow>
      </section>
      <section aria-label={t`Visuals`}>
        <h3 className="text-sm font-medium">
          <Trans>Visuals</Trans>
        </h3>
        <SettingsRow
          label={t`Inline visualizations`}
          description={t`Interactive visualizations, charts, and diagrams directly in the conversation.`}
        >
          <Switch
            aria-label={t`Inline visualizations`}
            checked={settings.inlineVisualizations}
            disabled={disabled}
            onCheckedChange={(inlineVisualizations) =>
              void change(() => onChange({ inlineVisualizations }))
            }
          />
        </SettingsRow>
      </section>
      <section aria-label={t`Code execution on computers`}>
        <SettingsRow
          label={t`Code execution on computers`}
          description={t`Network access lets a bot install packages and reach the internet. This comes with security risks.`}
        >
          <Button variant="ghost" onClick={onOpenComputers}>
            <Trans>Computers</Trans>
          </Button>
        </SettingsRow>
        {computers.map((computer) => (
          <SettingsRow
            key={computer.id}
            label={t`Allow network egress for ${computer.name}`}
            content={
              <>
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
              </>
            }
          >
            <Switch
              aria-label={t`Allow network egress for ${computer.name}`}
              checked={computer.networkEgress}
              disabled={disabled || !computer.supported || computer.pending}
              onCheckedChange={(networkEgress) =>
                setNetworkChange({ computerId: computer.id, networkEgress })
              }
            />
          </SettingsRow>
        ))}
      </section>
      <SettingsRow label={t`Skills`}>
        <Button variant="ghost" onClick={onOpenCustomize}>
          <Trans>Skills have moved to Customize</Trans>
        </Button>
      </SettingsRow>
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
