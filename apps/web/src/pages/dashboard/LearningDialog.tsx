import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";
import { INSIGHT_ACTION_EVENT } from "../../lib/insight-actions";
import { LearningInbox } from "../LearningInbox";

export default function LearningDialog({ onClose }: { onClose: () => void }) {
  // An insight's action opens another place; this dialog steps aside for it.
  useEffect(() => {
    window.addEventListener(INSIGHT_ACTION_EVENT, onClose);
    return () => window.removeEventListener(INSIGHT_ACTION_EVENT, onClose);
  }, [onClose]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent aria-describedby={undefined} className="max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>
            <Trans>Learning</Trans>
          </DialogTitle>
        </DialogHeader>
        <LearningInbox />
      </DialogContent>
    </Dialog>
  );
}
