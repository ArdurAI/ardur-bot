import { mcpReviewToolKind } from "@ardurbot/contracts";
import { Button, Checkbox, Dialog, DialogContent, DialogTitle } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { rpc } from "../../../lib/rpc";

export function BotToolReview({
  connectionId,
  botId,
  onClose,
  onSaved,
}: {
  connectionId: string;
  botId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLingui();
  const controlId = useId();
  const [review, setReview] = useState<Awaited<ReturnType<typeof rpc.integrations.toolReview>>>();
  const [selected, setSelected] = useState<string[]>([]);
  const [approveSpace, setApproveSpace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setReview(undefined);
    setError(false);
    setApproveSpace(false);
    void rpc.integrations
      .toolReview({ connectionId, botId })
      .then((value) => {
        if (!active) return;
        setReview(value);
        setSelected(
          value.manifest.tools
            .filter(
              (tool) =>
                mcpReviewToolKind(tool) === "read" &&
                (!botId || value.canApproveSpace || value.spaceAllowedTools.includes(tool.id)),
            )
            .map((tool) => tool.id),
        );
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [connectionId, botId]);
  async function save(all = false) {
    if (!review) return;
    setBusy(true);
    setError(false);
    try {
      const toolIds = all
        ? review.manifest.tools
            .filter((tool) => !botId || approveSpace || review.spaceAllowedTools.includes(tool.id))
            .map((tool) => tool.id)
        : selected;
      await rpc.integrations.reviewTools({
        connectionId,
        revision: review.revision,
        botId,
        toolIds,
        approveSpace,
      });
      onSaved();
      onClose();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const blocked = Boolean(botId && review?.spaceNeedsReview && !approveSpace);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[80vh] overflow-y-auto" data-testid="bot-tool-review">
        <DialogTitle>{t`Review tools`}</DialogTitle>
        {error ? <p role="alert">{t`Could not load or save tools.`}</p> : null}
        {review ? (
          <>
            {botId && review.canApproveSpace ? (
              <label htmlFor={`${controlId}-space`} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={`${controlId}-space`}
                  checked={approveSpace}
                  disabled={busy}
                  onCheckedChange={(checked) => setApproveSpace(Boolean(checked))}
                />
                {t`Also allow these tools for the space`}
              </label>
            ) : null}
            {botId &&
            (review.spaceNeedsReview ||
              selected.some((id) => !review.spaceAllowedTools.includes(id))) &&
            !approveSpace ? (
              <p className="text-sm text-muted-foreground">{t`Ask the space owner to review these tools in Settings.`}</p>
            ) : null}
            {(["read", "write"] as const).map((kind) => (
              <fieldset key={kind} disabled={busy} className="space-y-2">
                <legend>{kind === "read" ? t`Read` : t`Write`}</legend>
                {review.manifest.tools
                  .filter((tool) => mcpReviewToolKind(tool) === kind)
                  .map((tool) => (
                    <label
                      key={tool.id}
                      htmlFor={`${controlId}-${tool.id}`}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        id={`${controlId}-${tool.id}`}
                        aria-label={tool.id}
                        checked={selected.includes(tool.id)}
                        disabled={
                          busy ||
                          Boolean(
                            botId &&
                              !review.canApproveSpace &&
                              !review.spaceAllowedTools.includes(tool.id),
                          )
                        }
                        onCheckedChange={(checked) =>
                          setSelected((ids) =>
                            checked
                              ? [...new Set([...ids, tool.id])]
                              : ids.filter((id) => id !== tool.id),
                          )
                        }
                      />
                      {tool.id}
                    </label>
                  ))}
              </fieldset>
            ))}
            <div className="flex gap-2">
              <Button
                disabled={
                  busy ||
                  blocked ||
                  Boolean(
                    botId &&
                      !approveSpace &&
                      selected.some((id) => !review.spaceAllowedTools.includes(id)),
                  )
                }
                onClick={() => void save()}
              >{t`Allow selected`}</Button>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  blocked ||
                  Boolean(
                    botId &&
                      !approveSpace &&
                      review.manifest.tools.some(
                        (tool) => !review.spaceAllowedTools.includes(tool.id),
                      ),
                  )
                }
                onClick={() => void save(true)}
              >{t`Allow all`}</Button>
            </div>
          </>
        ) : (
          <p>{t`Loading your tools.`}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
