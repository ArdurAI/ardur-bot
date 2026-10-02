import type { IdeChange, WorkspaceContext } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useCallback, useState } from "react";
import { Changes, useChanges } from "../ide/changes";

const Diff = lazy(() => import("../ide/diff"));
const unchanged = () => {};

export function WorkspaceChanges({
  context,
  visible,
}: {
  context: WorkspaceContext;
  visible: boolean;
}) {
  const { t } = useLingui();
  const [selected, setSelected] = useState<IdeChange | null>(null);
  const [error, setError] = useState(false);
  const onError = useCallback(() => setError(true), []);
  const history = useChanges(context.rootId, visible, onError, unchanged);
  return (
    <div className="flex h-full min-h-0 flex-col" data-workspace-changes>
      {error ? (
        <p
          role="alert"
          className="p-2 text-xs text-destructive"
        >{t`Could not load files. Try again.`}</p>
      ) : null}
      {selected ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(null)}
          >{t`Recorded changes`}</Button>
          <div className="min-h-0 flex-1 overflow-auto">
            <Suspense fallback={null}>
              <Diff change={selected} />
            </Suspense>
          </div>
        </>
      ) : (
        <Changes items={history.items} more={history.more} onOpen={setSelected} onError={onError} />
      )}
    </div>
  );
}
