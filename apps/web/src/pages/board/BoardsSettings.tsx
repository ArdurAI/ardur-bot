import {
  antigravityEffortForModel,
  nativeRuntimeProviders,
  type RuntimeAvailability,
  type RuntimeKind,
  type SetLearningReviewerInput,
  type SpaceLearningConfig,
} from "@ardurbot/contracts";
import type { BoardConfiguration, BoardProblem, BoardWorkspace } from "@ardurbot/contracts/board";
import { modelPinOptionKey, parseModelPinOptionKey, hermesConnectionRefusal, spaceDefaultEffort } from "@ardurbot/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  NativeSelect,
  Switch,
} from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { useEffect, useState } from "react";
import { SuccessPop } from "../../components/ai/primitives";
import { SettingsRow } from "../../components/SettingsRow";
import { actionMessage } from "../../lib/orpc-action-message";
import { rpc } from "../../lib/rpc";
import type { ModelSettings } from "../../lib/use-model-settings";
import type { SettingsPageProps } from "../settings-types";
import { ModelEffortSelect, ModelPinSelect } from "../shell/model-pin-select";

const REVIEWER_PROBE_KINDS = ["claude-code", "codex-app-server", "antigravity", "hermes"] as const;
type ReviewerProbeKind = (typeof REVIEWER_PROBE_KINDS)[number];
const NATIVE_REVIEWER_KINDS = ["claude-code", "codex-app-server", "antigravity"] as const;
type NativeReviewerKind = (typeof NATIVE_REVIEWER_KINDS)[number];

function isNativeReviewerKind(kind: RuntimeKind): kind is NativeReviewerKind {
  return (NATIVE_REVIEWER_KINDS as readonly string[]).includes(kind);
}

async function loadReviewerProbes(): Promise<
  Partial<Record<ReviewerProbeKind, RuntimeAvailability | null>>
> {
  const entries = await Promise.all(
    REVIEWER_PROBE_KINDS.map(async (runtimeKind) => {
      const value = await rpc.runtimes.availability({ runtimeKind }).catch(() => null);
      return [runtimeKind, value] as const;
    }),
  );
  return Object.fromEntries(entries) as Partial<
    Record<ReviewerProbeKind, RuntimeAvailability | null>
  >;
}

/** A signed-in Codex, Claude Code, or Antigravity runtime is enough. Hermes still needs a connection. */
function nativeReviewerReady(
  probes: Partial<Record<ReviewerProbeKind, RuntimeAvailability | null>>,
) {
  return NATIVE_REVIEWER_KINDS.some((runtimeKind) => {
    const probe = probes[runtimeKind];
    return Boolean(probe?.available && probe.models.length > 0);
  });
}

function nativeReviewerEffort(
  kind: NativeReviewerKind,
  modelId: string,
  efforts: readonly string[],
  kept: string | null | undefined,
): string | null {
  if (kind === "antigravity") {
    const expected = antigravityEffortForModel(modelId);
    return expected === undefined ? (efforts[0] ?? null) : expected;
  }
  if (kept && efforts.includes(kept)) return kept;
  return efforts[0] ?? null;
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
    target: "refresh" | "upkeep" | "learning" | "name" | "status" | "default" | "bots" | "confirm";
    message: string;
  } | null>(null);
  const [problem, setProblem] = useState<BoardProblem | null>(null);
  const [confirm, setConfirm] = useState<"start" | "archive" | null>(null);
  const [upkeep, setUpkeep] = useState(true);
  const [learning, setLearning] = useState<SpaceLearningConfig | null>(null);
  const [modelSettings, setModelSettings] = useState<ModelSettings | null>(null);
  const [probes, setProbes] = useState<
    Partial<Record<ReviewerProbeKind, RuntimeAvailability | null>>
  >({});
  const [kind, setKind] = useState<RuntimeKind>("pi");
  const [savedPop, setSavedPop] = useState(false);
  const board = boards.find((row) => row.id === id) ?? boards[0];
  const savedReviewer = learning?.reviewerPin ?? null;
  const canChooseReviewer =
    (modelSettings?.credentials.length ?? 0) > 0 ||
    Boolean(savedReviewer?.provider && savedReviewer.modelId && savedReviewer.credentialId) ||
    nativeReviewerReady(probes);
  async function load() {
    const [result, bots, upkeepResult, learningResult, me, catalog, credentials, nextProbes] =
      await Promise.all([
        rpc.board.workspaces({}),
        rpc.bots.list(),
        rpc.board.upkeep({}),
        rpc.learning.settings(),
        rpc.me(),
        rpc.models.list(),
        rpc.models.credentials(),
        loadReviewerProbes(),
      ]);
    setBoards(result.workspaces);
    setProblem(result.problem);
    setBots(bots);
    setUpkeep(upkeepResult.enabled);
    setLearning(learningResult);
    setKind(learningResult.reviewerPin?.runtimeKind ?? "pi");
    setProbes(nextProbes);
    setModelSettings({ me, catalog, credentials });
    setLoaded(true);
  }
  function choiceForKind() {
    if (!learning) return null;
    const stored = learning.reviewerPin?.runtimeKind === kind ? learning.reviewerPin : null;
    const source = stored ?? (kind === "pi" ? learning.destination : null);
    if (!source?.provider || !source.modelId || !source.credentialId) return null;
    return {
      runtimeKind: kind,
      provider: source.provider,
      modelId: source.modelId,
      credentialId: source.credentialId,
    };
  }
  function saveReviewer(pin: SetLearningReviewerInput["pin"]) {
    if (!learning) return;
    void work(async () => {
      try {
        setLearning(
          await rpc.learning.setReviewer({
            expectedRevision: learning.reviewerPin?.revision ?? 0,
            pin,
          }),
        );
        setSavedPop(true);
        setTimeout(() => setSavedPop(false), 2000);
      } catch (error) {
        if (error instanceof ORPCError && error.code === "CONFLICT") {
          await load();
          throw new ORPCError("CONFLICT", {
            message: t`The reviewer was changed in another window.`,
          });
        }
        throw error;
      }
    }, "learning");
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
        label={t`Bots keep the board and memory current`}
        content={
          actionError?.target === "upkeep" ? <p role="alert">{actionError.message}</p> : undefined
        }
      >
        <Switch
          aria-label={t`Bots keep the board and memory current`}
          checked={upkeep}
          disabled={busy || !loaded}
          onCheckedChange={(enabled) =>
            void work(async () => {
              setUpkeep((await rpc.board.setUpkeep({ enabled })).enabled);
            }, "upkeep")
          }
        />
      </SettingsRow>
      {learning ? (
        <>
          <SettingsRow label={t`Learning review`}>
            {canChooseReviewer ? (
              <Switch
                aria-label={t`Learning review`}
                checked={learning.enabled}
                disabled={busy || !learning.canConfigure}
                onCheckedChange={(enabled) =>
                  void work(async () => {
                    setLearning(
                      await rpc.learning.configure({
                        enabled,
                        reviewerPin: learning.reviewerPin,
                        consolidationEnabled: learning.consolidationEnabled,
                        budgets: learning.budgets,
                      }),
                    );
                  }, "learning")
                }
              />
            ) : (
              <Button
                variant="outline"
                disabled={busy || !learning.canConfigure}
                onClick={() => navigate("models")}
              >
                <Trans>Connect a model</Trans>
              </Button>
            )}
          </SettingsRow>
          <SettingsRow
            label={t`Learning reviewer`}
            content={
              <div className="space-y-2 py-2">
                <p className="text-sm text-muted-foreground">
                  <Trans>Reviews use this connection and may incur model charges.</Trans>
                </p>
                {actionError?.target === "learning" ? (
                  <p role="alert" className="text-sm text-destructive">
                    {actionError.message}
                  </p>
                ) : null}
              </div>
            }
          >
            <div className="w-full">
              {learning.canConfigure ? (
                <>
                  <NativeSelect
                    id="learning-reviewer-runtime"
                    aria-label={t`Runs on`}
                    value={kind}
                    disabled={busy || !canChooseReviewer}
                    onChange={(event) => setKind(event.target.value as RuntimeKind)}
                  >
                    <option value="pi">{t`Ardur (built-in)`}</option>
                    <option value="claude-code">{t`Claude Code (your claude sign-in)`}</option>
                    <option value="codex-app-server">{t`Codex (your ChatGPT sign-in)`}</option>
                    <option value="antigravity">{t`Antigravity`}</option>
                    <option value="hermes">{t`Hermes`}</option>
                  </NativeSelect>
                  {kind === "pi" || kind === "hermes" ? (
                    <ModelPinSelect
                      id="learning-reviewer"
                      settings={modelSettings}
                      showAll={false}
                      disabled={busy || !canChooseReviewer}
                      isCredentialDisabled={
                        kind === "hermes"
                          ? (credential) =>
                              Boolean(hermesConnectionRefusal(credential.provider, credential))
                          : undefined
                      }
                      value={(() => {
                        const selected =
                          learning.reviewerPin?.runtimeKind === kind
                            ? learning.reviewerPin
                            : kind === "pi"
                              ? learning.destination
                              : null;
                        return selected?.provider && selected.modelId
                          ? modelPinOptionKey(
                              selected.provider,
                              selected.modelId,
                              selected.credentialId,
                            )
                          : "";
                      })()}
                      onChange={(value) => {
                        const selected = parseModelPinOptionKey(value);
                        if (!selected?.provider || !selected.modelId || !selected.credentialId)
                          return;
                        const entry = modelSettings?.catalog.find(
                          (item) =>
                            item.provider === selected.provider && item.id === selected.modelId,
                        );
                        const effortLevels = entry?.thinkingLevels ?? [];
                        const previous =
                          learning.reviewerPin?.runtimeKind === kind ? learning.reviewerPin : null;
                        const keptEffort =
                          previous?.effort &&
                          effortLevels.includes(previous.effort as (typeof effortLevels)[number])
                            ? previous.effort
                            : spaceDefaultEffort(undefined, effortLevels);
                        saveReviewer({
                          runtimeKind: kind,
                          provider: selected.provider,
                          modelId: selected.modelId,
                          credentialId: selected.credentialId,
                          effort: keptEffort,
                        });
                      }}
                    />
                  ) : (
                    <NativeSelect
                      id="learning-reviewer-native-model"
                      aria-label={t`Model`}
                      value={
                        learning.reviewerPin?.runtimeKind === kind
                          ? (learning.reviewerPin.modelId ?? "")
                          : ""
                      }
                      disabled={busy || !canChooseReviewer}
                      onChange={(event) => {
                        if (!isNativeReviewerKind(kind)) return;
                        const modelId = event.target.value;
                        if (!modelId) return;
                        const models = probes[kind]?.models ?? [];
                        const entry = models.find((item) => item.id === modelId);
                        const previous =
                          learning.reviewerPin?.runtimeKind === kind ? learning.reviewerPin : null;
                        saveReviewer({
                          runtimeKind: kind,
                          provider: nativeRuntimeProviders[kind],
                          modelId,
                          credentialId: `native:${kind}`,
                          effort: nativeReviewerEffort(
                            kind,
                            modelId,
                            entry?.efforts ?? [],
                            previous?.effort,
                          ),
                        });
                      }}
                    >
                      <option value="">{t`Choose a model`}</option>
                      {learning.reviewerPin?.runtimeKind === kind &&
                      learning.reviewerPin.modelId &&
                      !(probes[kind]?.models ?? []).some(
                        (item) => item.id === learning.reviewerPin?.modelId,
                      ) ? (
                        <option value={learning.reviewerPin.modelId}>
                          {learning.reviewerPin.modelId}
                        </option>
                      ) : null}
                      {(isNativeReviewerKind(kind) ? (probes[kind]?.models ?? []) : []).map(
                        (entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.label}
                          </option>
                        ),
                      )}
                    </NativeSelect>
                  )}
                  {kind === "pi" || kind === "hermes"
                    ? (() => {
                        const pin = choiceForKind();
                        if (!pin) return null;
                        const entry = modelSettings?.catalog.find(
                          (item) => item.provider === pin.provider && item.id === pin.modelId,
                        );
                        const effortLevels = entry?.thinkingLevels ?? [];
                        if (effortLevels.length === 0) return null;
                        const shown =
                          learning.reviewerPin?.runtimeKind === kind
                            ? learning.reviewerPin
                            : learning.destination;
                        return (
                          <ModelEffortSelect
                            id="learning-reviewer-effort"
                            supported={effortLevels}
                            isOllama={pin.provider === "ollama" || pin.provider === "local"}
                            defaultLevel="medium"
                            value={shown?.effort ?? ""}
                            disabled={busy}
                            allowDefault={false}
                            hideLabel={true}
                            onChange={(effort) => {
                              saveReviewer({ ...pin, effort });
                            }}
                          />
                        );
                      })()
                    : isNativeReviewerKind(kind) && kind !== "antigravity"
                      ? (() => {
                          const models = probes[kind]?.models ?? [];
                          const modelId =
                            learning.reviewerPin?.runtimeKind === kind
                              ? learning.reviewerPin.modelId
                              : "";
                          const entry = models.find((item) => item.id === modelId);
                          if (!entry || entry.efforts.length === 0) return null;
                          return (
                            <NativeSelect
                              id="learning-reviewer-effort"
                              aria-label={t`Thinking`}
                              value={
                                learning.reviewerPin?.runtimeKind === kind
                                  ? (learning.reviewerPin.effort ?? "")
                                  : ""
                              }
                              disabled={busy}
                              onChange={(event) => {
                                const pin = choiceForKind();
                                if (!pin || !event.target.value) return;
                                saveReviewer({ ...pin, effort: event.target.value });
                              }}
                            >
                              {entry.efforts.map((level) => (
                                <option key={level} value={level}>
                                  {level}
                                </option>
                              ))}
                            </NativeSelect>
                          );
                        })()
                      : null}
                  {savedPop ? <SuccessPop label={t`Saved`} /> : null}
                </>
              ) : (
                <div className="mt-2 text-sm">
                  {learning.reviewerPin?.modelId ??
                    learning.destination?.modelId ??
                    t`No reviewer model yet.`}
                  {learning.reviewerPin?.effort ? ` (${learning.reviewerPin.effort})` : ""}
                </div>
              )}
            </div>
          </SettingsRow>
        </>
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
          disabled={busy}
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
