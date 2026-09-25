import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { LearningInbox } from "../LearningInbox";

export default function LearningDialog({ onClose }: { onClose: () => void }) {
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
