import type { MessageBlock } from "@ardurbot/contracts";
import { chiefResultHref } from "@ardurbot/core";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { downloadArtifact } from "../../lib/artifact-open";

/** Loaded only when a saved result appears, keeping the chat entry bundle small. */
export function ChiefResultBubble({
  block,
}: {
  block: Extract<MessageBlock, { kind: "chief_result" }>;
}) {
  const { t } = useLingui();
  const [failed, setFailed] = useState(false);
  const result = block.result;
  if (!chiefResultHref(result.artifactId, result.href)) return null;
  return (
    <div
      data-testid="chief-result"
      className="rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5] text-foreground/90"
      dir="auto"
    >
      <span>
        {result.state === "verified-notion"
          ? t`Done — added the document to Notion.`
          : t`The draft is ready.`}
      </span>{" "}
      <a
        href={result.href}
        className="underline underline-offset-4"
        onClick={
          result.state === "draft"
            ? (event) => {
                event.preventDefault();
                setFailed(false);
                void downloadArtifact(
                  block.groupId ? { groupId: block.groupId } : { botId: block.botId },
                  result.artifactId,
                  block.name,
                  block.mimeType,
                ).catch(() => setFailed(true));
              }
            : undefined
        }
        rel="noopener noreferrer"
      >
        {block.name}
      </a>
      {failed ? (
        <span role="alert" className="block text-destructive">{t`Could not open file`}</span>
      ) : null}
    </div>
  );
}
