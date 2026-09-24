import type { Bot, ComparisonParticipant, ComparisonStart } from "@ardurbot/contracts";
import { inferAttachmentMimeType } from "@ardurbot/core";
import { Button, Checkbox, Dialog, DialogContent, DialogTitle } from "@ardurbot/ui-web";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { rpc } from "../lib/rpc";
import { ComparePanel, ComparisonPin } from "./ComparePanel";

export function CompareStart({
  botId,
  text,
  delegationId,
  files = [],
  disabled,
  onCreated,
}: {
  botId: string;
  text?: string;
  delegationId?: string;
  files?: File[];
  disabled?: boolean;
  onCreated?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [bots, setBots] = useState<Bot[]>([]);
  const [selected, setSelected] = useState([botId]);
  const [reserveMerge, setReserveMerge] = useState(true);
  const [preview, setPreview] = useState<{
    participants: ComparisonParticipant[];
    tokens: number;
    runs: number;
  } | null>(null);
  const [request, setRequest] = useState<ComparisonStart | null>(null);
  const [comparisonId, setComparisonId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(false);
    try {
      await fn();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || busy || (!delegationId && !text?.trim())}
        onClick={() =>
          void act(async () => {
            setBots(await rpc.bots.list());
            setSelected([botId]);
            setPreview(null);
            setRequest(null);
            setOpen(true);
          })
        }
      >
        {delegationId ? <Trans>Run on other bots</Trans> : <Trans>Compare with…</Trans>}
      </Button>
      {error && !open ? (
        <p role="alert">
          <Trans>Could not start comparison; retry.</Trans>
        </p>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>
            <Trans>Compare with…</Trans>
          </DialogTitle>
          {bots.map((bot) => (
            <label
              htmlFor={`compare-bot-${bot.id}`}
              key={bot.id}
              className="flex items-center gap-2"
            >
              <Checkbox
                id={`compare-bot-${bot.id}`}
                checked={selected.includes(bot.id)}
                disabled={
                  busy || bot.id === botId || (!selected.includes(bot.id) && selected.length === 4)
                }
                onCheckedChange={(checked) => {
                  setPreview(null);
                  setRequest(null);
                  setSelected((current) =>
                    checked ? [...current, bot.id] : current.filter((id) => id !== bot.id),
                  );
                }}
              />
              {bot.name}
            </label>
          ))}
          <label htmlFor={`compare-merge-${botId}`} className="flex items-center gap-2">
            <Checkbox
              id={`compare-merge-${botId}`}
              checked={reserveMerge}
              disabled={busy}
              onCheckedChange={(checked) => {
                setReserveMerge(checked);
                setPreview(null);
                setRequest(null);
              }}
            />
            <Trans>Reserve a merge run</Trans>
          </label>
          {preview ? (
            <div className="space-y-3">
              {preview.participants.map((participant) => (
                <div key={participant.botId}>
                  <p>{participant.name}</p>
                  <ComparisonPin participant={participant} />
                </div>
              ))}
              <p>
                <Trans>{preview.runs} runs at these pins; hosted providers may bill per run</Trans>
              </p>
              <p>
                <Trans>Token reservation</Trans>: {preview.tokens}
              </p>
            </div>
          ) : null}
          {error ? (
            <p role="alert">
              <Trans>Could not start comparison; review the pins and retry.</Trans>
            </p>
          ) : null}
          <Button
            disabled={busy || selected.length < 2}
            onClick={() =>
              void act(async () => {
                if (preview && request) {
                  const comparison = await rpc.comparisons.create({
                    ...request,
                    expectedParticipants: preview.participants,
                  });
                  setComparisonId(comparison.id);
                  setOpen(false);
                  onCreated?.();
                  return;
                }
                const artifactIds: string[] = [];
                for (const file of files) {
                  const mimeType = inferAttachmentMimeType(file.name, file.type);
                  if (!mimeType) throw new Error("Unsupported attachment");
                  const contentBase64 = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(file);
                  });
                  const artifact = await rpc.artifacts.create({
                    botId,
                    name: file.name,
                    mimeType,
                    contentBase64,
                  });
                  artifactIds.push(artifact.id);
                }
                const input: ComparisonStart = {
                  coordinatorBotId: botId,
                  participantBotIds: selected,
                  ...(delegationId ? { delegationId } : { text: text!.trim() }),
                  artifactIds,
                  reserveMerge,
                  clientNonce: crypto.randomUUID(),
                };
                setRequest(input);
                setPreview(await rpc.comparisons.preview(input));
              })
            }
          >
            {preview ? <Trans>Start comparison</Trans> : <Trans>Preview</Trans>}
          </Button>
        </DialogContent>
      </Dialog>
      {comparisonId ? (
        <ComparePanel id={comparisonId} onClose={() => setComparisonId(null)} />
      ) : null}
    </>
  );
}
