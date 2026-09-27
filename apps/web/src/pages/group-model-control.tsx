import type {
  Bot,
  GroupMember,
  RuntimeKind,
  SetGroupMemberModelPinInput,
  ThinkingLevel,
} from "@ardurbot/contracts";
import { modelPinOptionKey, parseModelPinOptionKey, spaceDefaultEffort } from "@ardurbot/core";
import { Button } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { ShowAllModels } from "../components/ShowAllModels";
import type { ModelSettings } from "../lib/use-model-settings";
import { ModelEffortSelect, ModelPinSelect } from "./shell/model-pin-select";
import { RuntimeSettings } from "./shell/runtime-settings";

export function GroupModelControl({
  member,
  bot,
  settings,
  onSave,
  onReload,
}: {
  member?: GroupMember;
  bot: Bot;
  settings: ModelSettings | null;
  onSave: (member: GroupMember, pin: SetGroupMemberModelPinInput["pin"] | null) => Promise<void>;
  onReload?: (member: GroupMember) => Promise<GroupMember | undefined>;
}) {
  const { t } = useLingui();
  const id = useId();
  const [activeMember, setActiveMember] = useState(member);
  const confirmed = activeMember?.runtimePin ?? null;
  const [inherit, setInherit] = useState(!confirmed);
  const [kind, setKind] = useState<RuntimeKind>(confirmed?.runtimeKind ?? "pi");
  const [key, setKey] = useState(
    confirmed?.provider && confirmed.modelId
      ? modelPinOptionKey(confirmed.provider, confirmed.modelId, confirmed.credentialId)
      : "",
  );
  const [effort, setEffort] = useState(confirmed?.effort ?? "");
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedModel = parseModelPinOptionKey(key);
  const selectedCredential = settings?.credentials.find(
    (item) => item.id === selectedModel?.credentialId,
  );
  const selectedEntry = settings?.catalog.find(
    (item) => item.provider === selectedModel?.provider && item.id === selectedModel.modelId,
  );
  const supportedEffort: ThinkingLevel[] =
    selectedCredential?.thinkingLevels ?? selectedEntry?.thinkingLevels ?? [];
  const defaultEffort =
    selectedCredential?.thinkingLevel ??
    spaceDefaultEffort(selectedCredential?.reasoning ?? selectedEntry?.reasoning, supportedEffort);
  useEffect(() => {
    setActiveMember(member);
  }, [member?.memberId, member?.modelPinRevision]);
  useEffect(() => {
    setInherit(!confirmed);
    setKind(confirmed?.runtimeKind ?? "pi");
    setKey(
      confirmed?.provider && confirmed.modelId
        ? modelPinOptionKey(confirmed.provider, confirmed.modelId, confirmed.credentialId)
        : "",
    );
    setEffort(confirmed?.effort ?? "");
  }, [activeMember?.memberId, activeMember?.modelPinRevision]);

  async function save() {
    if (!activeMember?.memberId || saving) return;
    const selected = parseModelPinOptionKey(key);
    if (!inherit && (!selected?.provider || !selected.modelId || !selected.credentialId)) return;
    const credential = settings?.credentials.find((item) => item.id === selected?.credentialId);
    const catalogEntry = settings?.catalog.find(
      (item) => item.provider === selected?.provider && item.id === selected.modelId,
    );
    const nextEffort =
      kind === "pi" &&
      selected?.provider === "ollama" &&
      (credential?.reasoning ?? catalogEntry?.reasoning) === false
        ? null
        : effort ||
          (kind === "pi"
            ? (credential?.thinkingLevel ??
              spaceDefaultEffort(
                credential?.reasoning ?? catalogEntry?.reasoning,
                credential?.thinkingLevels ?? catalogEntry?.thinkingLevels,
              ))
            : null);
    setSaving(true);
    setError(null);
    try {
      await onSave(
        activeMember,
        inherit
          ? null
          : {
              runtimeKind: kind,
              provider: selected!.provider,
              modelId: selected!.modelId,
              credentialId: selected!.credentialId!,
              effort: nextEffort,
            },
      );
    } catch (cause) {
      const conflict =
        typeof cause === "object" && cause !== null && "code" in cause && cause.code === "CONFLICT";
      const reloaded = conflict ? await onReload?.(activeMember).catch(() => undefined) : undefined;
      if (reloaded) setActiveMember(reloaded);
      const restored = reloaded ? (reloaded.runtimePin ?? null) : confirmed;
      setInherit(!restored);
      setKind(restored?.runtimeKind ?? "pi");
      setKey(
        restored?.provider && restored.modelId
          ? modelPinOptionKey(restored.provider, restored.modelId, restored.credentialId)
          : "",
      );
      setEffort(restored?.effort ?? "");
      setError(
        conflict && cause instanceof Error && cause.message
          ? cause.message
          : t`Could not save group model.`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-border p-2" data-testid={`group-model-${bot.id}`}>
      <label htmlFor={`${id}-model`} className="text-xs text-muted-foreground">
        <Trans>Model in this group</Trans> · {bot.name}
      </label>
      {kind === "pi" ? (
        <ModelPinSelect
          id={`${id}-model`}
          settings={settings}
          showAll={showAll}
          value={inherit ? "" : key}
          disabled={!member?.memberId || saving}
          defaultLabel={t`Same as bot`}
          onChange={(value) => {
            setInherit(!value);
            setKey(value);
            setEffort("");
          }}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setInherit(true);
            setKind("pi");
            setKey("");
          }}
        >
          <Trans>Same as bot</Trans>
        </Button>
      )}
      {!inherit && kind === "pi" ? (
        <>
          <ShowAllModels checked={showAll} onChange={setShowAll} />
          <ModelEffortSelect
            id={`${id}-effort`}
            value={effort}
            onChange={setEffort}
            supported={supportedEffort}
            isOllama={selectedModel?.provider === "ollama"}
            defaultLevel={defaultEffort}
            notApplicable={
              selectedModel?.provider === "ollama" &&
              (selectedCredential?.reasoning ?? selectedEntry?.reasoning) === false
            }
            disabled={saving}
          />
        </>
      ) : null}
      {activeMember?.memberId ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            <Trans>Runtime</Trans>
          </summary>
          <RuntimeSettings
            kind={kind}
            onKind={(value) => {
              setKind(value);
              setInherit(false);
              setKey("");
              setEffort("");
            }}
            modelKey={key}
            onModel={(value) => {
              setKey(value);
              setInherit(false);
            }}
            effort={effort}
            onEffort={setEffort}
            experimental={bot.runtimeExperimental ?? false}
            onExperimental={() => undefined}
            experimentalReadOnly
          />
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        size="sm"
        className="mt-2"
        disabled={
          !activeMember?.memberId ||
          saving ||
          (!inherit && !key) ||
          (kind !== "pi" && !bot.runtimeExperimental)
        }
        onClick={() => void save()}
      >
        {saving ? <Trans>Saving…</Trans> : <Trans>Save model</Trans>}
      </Button>
    </div>
  );
}
