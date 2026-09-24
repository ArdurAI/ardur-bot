import { Button, Dialog, DialogContent, DialogTitle } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { IntegrationCatalog } from "../../components/integrations/catalog/IntegrationCatalog";

export function ConnectorSuggestion({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <span className="me-4 text-sm font-medium">{name}</span>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Trans>Connect</Trans>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>
            <Trans>Connectors</Trans>
          </DialogTitle>
          <IntegrationCatalog />
        </DialogContent>
      </Dialog>
    </div>
  );
}
