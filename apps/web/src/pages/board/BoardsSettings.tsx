import type { BoardConfiguration, BoardProblem, BoardWorkspace } from "@ardurbot/contracts/board";
import { Button, Dialog, DialogContent, DialogTitle, Input, NativeSelect } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { fallbackORPCErrorMessage, ORPCError } from "@orpc/client";
import { useEffect, useState } from "react";
import { SettingsRow } from "../../components/SettingsRow";
import { rpc } from "../../lib/rpc";
import type { SettingsPageProps } from "../settings-types";

function actionMessage(error: unknown, fallback: string) {
  if (!(error instanceof ORPCError) || !error.message) return fallback;
  if (!error.defined && error.message === fallbackORPCErrorMessage(error.code, undefined))
    return fallback;
  return error.message;
}

export default function BoardsSettings({ onBusyChange, navigate }: SettingsPageProps) {
  const { t } = useLingui();
  const [boards, setBoards] = useState<BoardWorkspace[]>([]);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState<{
    target: "refresh" | "name" | "status" | "default" | "bots" | "confirm";
    message: string;
  } | null>(null);
  const [problem, setProblem] = useState<BoardProblem | null>(null);
  const [confirm, setConfirm] = useState<"start" | "archive" | null>(null);
  const board = boards.find((row) => row.id === id) ?? boards[0];
  async function load() {
    const [result, bots] = await Promise.all([rpc.board.workspaces({}), rpc.bots.list()]);
    setBoards(result.workspaces);
    setProblem(result.problem);
    setBots(bots);
    setLoaded(true);
  }
  useEffect(() => {
    let active = true;
    void load().catch(() => {
      if (active) setError(true);
    });
    return () => {
      active = false;
    };
  }, []);
  async function work(
    action: () => Promise<unknown>,
    target: NonNullable<typeof actionError>["target"],
  ) {
    setBusy(true);
    onBusyChange(true);
    setActionError(null);
    let acted = false;
    try {
      await action();
      acted = true;
      setConfirm(null);
      await load();
    } catch (error) {
      setActionError({
        target: acted ? "refresh" : target,
        message: actionMessage(error, t`Could not complete this action.`),
      });
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  const configure = (
    patch: BoardConfiguration,
    target: NonNullable<typeof actionError>["target"],
  ) =>
    board &&
    work(
      () =>
        rpc.board.configure({
          workspaceId: board.id,
          patch: {
            ...patch,
            ...(patch.allowedBotIds
              ? {
                  allowedBotIds: patch.allowedBotIds.filter((id) =>
                    bots.some((bot) => bot.id === id),
                  ),
                }
              : {}),
          },
        }),
      target,
    );
  return (
    <div className="space-y-4">
      {!loaded && !error ? (
        <div aria-busy="true" className="h-20 animate-pulse rounded-lg bg-muted" />
      ) : null}
      {error ? (
        <p role="alert">
          <Trans>Could not load</Trans>{" "}
          <Button
            variant="ghost"
            onClick={() => {
              setError(false);
              void load().catch(() => setError(true));
            }}
          >
            <Trans>Retry</Trans>
          </Button>
        </p>
      ) : null}
      <SettingsRow
        label={t`Beads`}
        content={
          problem ? (
            <div role="alert" className="space-y-2 py-2">
              <p>{problem.message}</p>
              {problem.code === "not_installed" ? (
                <a
                  className="underline"
                  href="https://github.com/gastownhall/beads#installation"
                  target="_blank"
                  rel="noreferrer"
                >
                  <Trans>Install Beads</Trans>
                </a>
              ) : null}
            </div>
          ) : actionError?.target === "refresh" ? (
            <p role="alert">{actionError.message}</p>
          ) : undefined
        }
      >
        <span className="text-sm text-muted-foreground">
          {loaded && !problem ? t`Connected` : t`Not connected`}
        </span>
        <Button variant="outline" disabled={busy} onClick={() => void work(load, "refresh")}>
          <Trans>Refresh</Trans>
        </Button>
      </SettingsRow>
      <SettingsRow label={t`Registered folders`}>
        <Button variant="ghost" onClick={() => navigate("computer")}>
          <Trans>Computers</Trans>
        </Button>
      </SettingsRow>
      {boards.length ? (
        <NativeSelect
          aria-label={t`Board`}
          value={board?.id ?? ""}
          onChange={(event) => {
            setId(event.target.value);
            setActionError(null);
          }}
        >
          {boards.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
              {!row.enabled ? ` · ${t`Archived`}` : ""}
            </option>
          ))}
        </NativeSelect>
      ) : null}
      {board ? (
        <div key={board.id}>
          <SettingsRow
            label={t`Name`}
            content={
              <div className="space-y-2 py-2">
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
                    if (name) void configure({ name }, "name");
                  }}
                >
                  <Input
                    name="name"
                    aria-label={t`Name`}
                    defaultValue={board.name}
                    maxLength={100}
                    required
                  />
                  <Button disabled={busy} type="submit">
                    <Trans>Save</Trans>
                  </Button>
                </form>
                {actionError?.target === "name" ? <p role="alert">{actionError.message}</p> : null}
              </div>
            }
          >
            <span className="text-sm text-muted-foreground">
              {board.kind === "space" ? t`Space board` : t`Folder board`}
            </span>
          </SettingsRow>
          <SettingsRow
            label={t`Board status`}
            content={
              board.kind === "folder" || actionError?.target === "status" ? (
                <div className="space-y-2 py-2">
                  {board.kind === "folder" ? (
                    <p className="break-all text-sm text-muted-foreground">{board.path}</p>
                  ) : null}
                  {actionError?.target === "status" ? (
                    <p role="alert">{actionError.message}</p>
                  ) : null}
                </div>
              ) : undefined
            }
          >
            <span>
              {!board.enabled ? t`Archived` : board.initialized ? t`Ready` : t`Not initialized`}
            </span>
            {board.enabled && !board.initialized ? (
              <Button disabled={busy} onClick={() => setConfirm("start")}>
                <Trans>Start board</Trans>
              </Button>
            ) : null}
            {!board.enabled ? (
              <Button disabled={busy} onClick={() => void configure({ enabled: true }, "status")}>
                <Trans>Restore</Trans>
              </Button>
            ) : null}
          </SettingsRow>
          <SettingsRow
            label={t`Default board`}
            content={
              actionError?.target === "default" ? (
                <p role="alert">{actionError.message}</p>
              ) : undefined
            }
          >
            <Button
              variant="outline"
              disabled={busy || board.isDefault || !board.enabled || !board.initialized}
              onClick={() => void configure({ isDefault: true }, "default")}
            >
              {board.isDefault ? <Trans>Default</Trans> : <Trans>Make default</Trans>}
            </Button>
          </SettingsRow>
          <SettingsRow
            label={t`Allowed bots`}
            content={
              !board.allowAllBots || actionError?.target === "bots" ? (
                <div className="space-y-2 py-2">
                  {!board.allowAllBots
                    ? bots.map((bot) => (
                        <label key={bot.id} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={board.allowedBotIds.includes(bot.id)}
                            disabled={busy}
                            onChange={(event) =>
                              void configure(
                                {
                                  allowedBotIds: event.target.checked
                                    ? [...board.allowedBotIds, bot.id]
                                    : board.allowedBotIds.filter((id) => id !== bot.id),
                                },
                                "bots",
                              )
                            }
                          />
                          {bot.name}
                        </label>
                      ))
                    : null}
                  {actionError?.target === "bots" ? (
                    <p role="alert">{actionError.message}</p>
                  ) : null}
                </div>
              ) : undefined
            }
          >
            <NativeSelect
              aria-label={t`Allowed bots`}
              value={board.allowAllBots ? "all" : "selected"}
              disabled={busy}
              onChange={(event) =>
                void configure({ allowAllBots: event.target.value === "all" }, "bots")
              }
            >
              <option value="all">{t`All bots`}</option>
              <option value="selected">{t`Selected bots`}</option>
            </NativeSelect>
          </SettingsRow>
          {board.enabled ? (
            <Button variant="outline" disabled={busy} onClick={() => setConfirm("archive")}>
              <Trans>Archive board</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {confirm === "archive" ? <Trans>Archive board?</Trans> : <Trans>Start board?</Trans>}
          </DialogTitle>
          <p>
            {confirm === "archive" ? (
              <Trans>Board files will be kept.</Trans>
            ) : (
              <Trans>
                Creates .beads/ with config.yaml, metadata.json, .gitignore, README.md,
                interactions.jsonl, .local_version, and embeddeddolt/. Git files and hooks stay
                unchanged.
              </Trans>
            )}
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              board &&
              void work(
                () =>
                  confirm === "archive"
                    ? rpc.board.configure({ workspaceId: board.id, patch: { enabled: false } })
                    : rpc.board.start({ workspaceId: board.id }),
                "confirm",
              )
            }
          >
            <Trans>Confirm</Trans>
          </Button>
          {actionError?.target === "confirm" ? <p role="alert">{actionError.message}</p> : null}
          <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
            <Trans>Cancel</Trans>
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
