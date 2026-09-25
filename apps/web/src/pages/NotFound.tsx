import { Button } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <main className="grid h-full place-content-center justify-items-center gap-6 bg-background p-6">
      <h1 className="text-2xl font-medium">
        <Trans>Page not found</Trans>
      </h1>
      <Button nativeButton={false} role="link" render={<Link to="/" />}>
        <Trans>Back to home</Trans>
      </Button>
    </main>
  );
}
