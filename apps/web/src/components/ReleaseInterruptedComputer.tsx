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
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { computerUpdates } from "../lib/computer-updates";

export function ReleaseInterruptedComputer({
  updateId,
  onReleased,
}: {
  updateId: string;
  onReleased?: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          setError(false);
          setConfirm(true);
        }}
      >
        <Trans>Release computer</Trans>
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not complete action</Trans>
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
              <Trans>Release interrupted computer?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Make sure nothing is still running on this computer.</Trans>
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
                setPending(true);
                setError(false);
                void computerUpdates
                  .releaseInterrupted(updateId)
                  .then(() => {
                    setConfirm(false);
                    onReleased?.();
                  })
                  .catch(() => {
                    setConfirm(false);
                    setError(true);
                  })
                  .finally(() => setPending(false));
              }}
            >
              <Trans>Nothing is still running</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
