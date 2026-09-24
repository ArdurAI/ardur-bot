import { Button, Dialog, DialogContent, DialogTitle, Skeleton } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { lazy, Suspense, useState } from "react";

const IntegrationCatalog = lazy(() =>
  import("../../components/integrations/catalog/IntegrationCatalog").then((module) => ({
    default: module.IntegrationCatalog,
  })),
);

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
          <Suspense fallback={<Skeleton className="h-40 w-full" />}>
            <IntegrationCatalog />
          </Suspense>
        </DialogContent>
      </Dialog>
    </div>
  );
}
