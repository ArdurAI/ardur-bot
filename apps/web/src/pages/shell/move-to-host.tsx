import type { ComputerStatus, RuntimeComputerLocation, RuntimeKind } from "@ardurbot/contracts";
import { computerExecutionKind, runtimeSupportsLocation } from "@ardurbot/contracts";
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
} from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { rpc } from "../../lib/rpc";

export function MoveToHost({
  botId,
  runtimeKind,
  location,
  hostAvailable,
  state,
  onChanged,
}: {
  botId: string;
  runtimeKind: RuntimeKind;
  location: RuntimeComputerLocation;
  hostAvailable: boolean;
  state: ComputerStatus["state"];
  onChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const mismatch =
    !runtimeSupportsLocation(runtimeKind, location) &&
    runtimeSupportsLocation(runtimeKind, { kind: "desktop" }) &&
    computerExecutionKind(location) !== "desktop";
  if (!mismatch) return null;
  async function move() {
    setPending(true);
    setError("");
    try {
      await rpc.computer.configure({ botId, destination: "host", confirmed: true });
      setConfirm(false);
      await onChanged();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t`Could not change the computer; stop its bots and try again.`,
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        disabled={!hostAvailable || pending || state === "booting" || state === "suspending"}
        onClick={() => setConfirm(true)}
      >
        <Trans>Move to This computer</Trans>
      </Button>
      {!hostAvailable ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Connect the host service to choose This computer.</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <AlertDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!pending) setConfirm(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Change computer</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Runs as you; can use your files and signed-in tools</Trans>{" "}
              <Trans>This replaces the computer's files. Continue?</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void move();
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
