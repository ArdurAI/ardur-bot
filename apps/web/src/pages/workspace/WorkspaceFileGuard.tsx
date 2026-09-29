import { useLingui } from "@lingui/react/macro";
import { useSyncExternalStore } from "react";
import { subscribeWorkspaceFiles, workspaceFilesSnapshot } from "./file-sessions";
import { useUnsavedChanges } from "./unsaved";

/** One guard for the conversation shell, so a second editor mount cannot replace it. */
export function WorkspaceFileGuard() {
  const { t } = useLingui();
  const files = useSyncExternalStore(
    subscribeWorkspaceFiles,
    workspaceFilesSnapshot,
    workspaceFilesSnapshot,
  );
  useUnsavedChanges(files.dirty || files.saving, t`Unsaved changes`, files.saving);
  return null;
}
