import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";
import { MemoryHistory } from "../MemoryHistory";
import type { CategorizedMemoryDocument } from "./document-groups";
import {
  groupMemoryDocuments,
  memoryDocumentSummary,
  memoryTopicTitle,
  memoryUpdatedDate,
} from "./document-groups";

export function MemoryDocuments({
  documents,
  onChange,
}: {
  documents: CategorizedMemoryDocument[];
  onChange: (document: CategorizedMemoryDocument) => void;
}) {
  const { t, i18n } = useLingui();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const groups = groupMemoryDocuments(documents);
  const selected = [...groups.you, ...groups.topics].find((document) => document.id === selectedId);

  function rows(items: CategorizedMemoryDocument[]) {
    return items.map((document) => (
      <li key={document.id}>
        <Button
          variant="ghost"
          className="h-auto w-full justify-between gap-4 whitespace-normal px-0 py-3 text-start"
          aria-expanded={selectedId === document.id}
          onClick={() => setSelectedId(selectedId === document.id ? null : document.id)}
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              {document.kind === "profile"
                ? t`Profile`
                : document.kind === "preferences"
                  ? t`Preferences`
                  : memoryTopicTitle(document)}
            </span>
            <span className="block truncate text-sm font-normal text-muted-foreground">
              {document.kind === "profile"
                ? t`Who the user is and the professional domain`
                : document.kind === "preferences"
                  ? t`How the user wants the assistant to respond`
                  : memoryDocumentSummary(document.content)}
            </span>
          </span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">
            <Trans>Updated</Trans>{" "}
            <time dateTime={document.updatedAt}>
              {memoryUpdatedDate(document.updatedAt, i18n.locale)}
            </time>
          </span>
        </Button>
      </li>
    ));
  }

  return (
    <div className="space-y-6">
      <SettingsRow
        label={t`You`}
        content={
          <>
            {groups.you.length ? (
              <ul className="divide-y divide-border">{rows(groups.you)}</ul>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">
                <Trans>No profile or preferences saved.</Trans>
              </p>
            )}
          </>
        }
      >
        {null}
      </SettingsRow>
      <SettingsRow
        label={t`Topics`}
        content={
          <>
            {groups.topics.length ? (
              <ul className="divide-y divide-border">{rows(groups.topics)}</ul>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">
                <Trans>No topics saved.</Trans>
              </p>
            )}
          </>
        }
      >
        {null}
      </SettingsRow>
      {selected ? (
        <section
          className="space-y-3 rounded-lg border border-border p-4"
          aria-label={t`Memory document`}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">
              {selected.kind === "profile"
                ? t`Profile`
                : selected.kind === "preferences"
                  ? t`Preferences`
                  : memoryTopicTitle(selected)}
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
              <Trans>Close</Trans>
            </Button>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">{selected.content}</p>
          <details>
            <summary className="cursor-pointer text-sm">
              <Trans>History</Trans>
            </summary>
            <MemoryHistory key={selected.id} document={selected} onChange={onChange} />
          </details>
        </section>
      ) : null}
    </div>
  );
}
