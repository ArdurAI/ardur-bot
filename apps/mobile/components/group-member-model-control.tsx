import type { GroupMember, RuntimeKind, SetGroupMemberModelPinInput } from "@ardurbot/contracts";
import { runtimeLabels } from "@ardurbot/contracts";
import { hermesConnectionRefusal, rpcErrorMessage, spaceDefaultEffort } from "@ardurbot/core";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import type { MobileBot, MobileGroup, MobileModel, MobileModelCredential } from "../lib/api";
import { rpc } from "../lib/api";
import { hermesRefusalMessage } from "../lib/hermes-refusal";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { RpcError } from "../lib/rpc-error";

type Choice = { label: string; pin: SetGroupMemberModelPinInput["pin"] };

function effortLabel(level: string, t: (message: string) => string) {
  if (level === "xhigh") return t("Extra high");
  if (level === "low") return t("Low");
  if (level === "medium") return t("Medium");
  if (level === "high") return t("High");
  if (level === "minimal") return t("Minimal");
  if (level === "max") return t("Max");
  if (level === "off") return t("Off");
  return level.slice(0, 1).toUpperCase() + level.slice(1);
}

export function GroupMemberModelControl({
  groupId,
  member,
  catalog,
  credentials,
  botRuntimeKind,
  bot,
  experimental,
  onSaved,
  onBotReloaded,
  onError,
}: {
  groupId: string;
  member: GroupMember;
  catalog: MobileModel[];
  credentials: MobileModelCredential[];
  botRuntimeKind?: RuntimeKind;
  bot?: MobileBot;
  experimental?: boolean;
  onSaved: (group: MobileGroup) => void;
  onBotReloaded?: (bot: MobileBot) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const [pending, setPending] = useState(false);
  const [activeMember, setActiveMember] = useState(member);
  const [activeBot, setActiveBot] = useState(bot);
  const initialKind =
    member.runtimePin?.runtimeKind ??
    member.effectiveRuntimePin?.runtimeKind ??
    botRuntimeKind ??
    bot?.runtimeKind ??
    "pi";
  const [draftKind, setDraftKind] = useState<RuntimeKind>(initialKind);
  const connectionKind = draftKind === "hermes" ? "hermes" : "pi";

  useEffect(() => {
    setActiveMember(member);
    setDraftKind(
      member.runtimePin?.runtimeKind ??
        member.effectiveRuntimePin?.runtimeKind ??
        botRuntimeKind ??
        bot?.runtimeKind ??
        "pi",
    );
  }, [member, botRuntimeKind, bot?.runtimeKind]);

  useEffect(() => setActiveBot(bot), [bot]);

  const choices = useMemo<Choice[]>(() => {
    const currentPin = activeMember.runtimePin;
    const result: Choice[] = [];
    for (const credential of credentials) {
      // Sign-in connections stay off the Hermes choices; key-based ones are served.
      if (connectionKind === "hermes" && hermesConnectionRefusal(credential.provider, credential))
        continue;
      const hasSeveralConnections = credentials.some(
        (item) => item.id !== credential.id && item.provider === credential.provider,
      );
      for (const entry of catalog) {
        if (
          entry.provider !== credential.provider ||
          entry.placeholder ||
          (entry.credentialId && entry.credentialId !== credential.id)
        )
          continue;
        const matchesCurrent =
          currentPin != null &&
          currentPin.provider === entry.provider &&
          currentPin.modelId === entry.id &&
          currentPin.credentialId === credential.id;
        const defaultEffort =
          entry.provider === "ollama" && (credential.reasoning ?? entry.reasoning) === false
            ? null
            : (credential.thinkingLevel ??
              spaceDefaultEffort(
                credential.reasoning ?? entry.reasoning,
                credential.thinkingLevels ?? entry.thinkingLevels,
              ));
        result.push({
          label: `${hasSeveralConnections ? credential.label : (entry.providerName ?? entry.provider)} · ${entry.label}`,
          pin: {
            runtimeKind: connectionKind,
            provider: entry.provider,
            modelId: entry.id,
            credentialId: credential.id,
            effort: matchesCurrent ? currentPin.effort : defaultEffort,
          },
        });
      }
      if (credential.provider === "openai-compatible" && credential.modelId) {
        const matchesCurrent =
          currentPin != null &&
          currentPin.provider === credential.provider &&
          currentPin.modelId === credential.modelId &&
          currentPin.credentialId === credential.id;
        const defaultEffort =
          credential.thinkingLevel ??
          spaceDefaultEffort(credential.reasoning, credential.thinkingLevels);
        result.push({
          label: `${credential.label} · ${credential.modelId}`,
          pin: {
            runtimeKind: connectionKind,
            provider: credential.provider,
            modelId: credential.modelId,
            credentialId: credential.id,
            effort: matchesCurrent ? currentPin.effort : defaultEffort,
          },
        });
      }
    }
    return result;
  }, [catalog, credentials, activeMember.runtimePin, connectionKind]);

  async function choose(pin: Choice["pin"] | null, preserveCurrentEffort = true) {
    if (!activeMember.memberId || activeMember.modelPinRevision == null || pending) return;
    const currentPin = activeMember.runtimePin;
    const resolvedPin =
      pin &&
      currentPin &&
      pin.provider === currentPin.provider &&
      pin.modelId === currentPin.modelId &&
      pin.credentialId === currentPin.credentialId &&
      preserveCurrentEffort
        ? { ...pin, effort: currentPin.effort }
        : pin;
    setPending(true);
    onError("");
    try {
      const target = {
        groupId,
        botId: activeMember.botId,
        memberId: activeMember.memberId,
        expectedRevision: activeMember.modelPinRevision ?? 0,
      };
      const group = await rpc<MobileGroup>(
        resolvedPin ? "groups/setMemberModelPin" : "groups/clearMemberModelPin",
        resolvedPin
          ? {
              ...target,
              expectedBotModelPinRevision: activeBot?.modelPinRevision ?? 0,
              pin: resolvedPin,
            }
          : target,
      );
      const updatedMember =
        group.members.find(
          (item) => item.memberId === activeMember.memberId || item.botId === activeMember.botId,
        ) ?? activeMember;
      setActiveMember(updatedMember);
      setDraftKind(
        resolvedPin
          ? resolvedPin.runtimeKind
          : (updatedMember.runtimePin?.runtimeKind ??
              updatedMember.effectiveRuntimePin?.runtimeKind ??
              botRuntimeKind ??
              bot?.runtimeKind ??
              "pi"),
      );
      onSaved(group);
    } catch (error: unknown) {
      const isConflict =
        (error instanceof RpcError && error.code === "CONFLICT") ||
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "CONFLICT") ||
        (error instanceof Error &&
          error.message.includes("This member's model changed. Reload the group."));
      if (isConflict) {
        let refreshedMember: GroupMember | undefined;
        try {
          const [groupsResult, botsResult] = await Promise.allSettled([
            rpc<MobileGroup[]>("groups/list"),
            rpc<MobileBot[]>("bots/list"),
          ]);
          const refreshedBot =
            botsResult.status === "fulfilled"
              ? botsResult.value.find((item) => item.id === activeMember.botId)
              : undefined;
          if (refreshedBot) {
            setActiveBot(refreshedBot);
            onBotReloaded?.(refreshedBot);
          }
          const refreshed =
            groupsResult.status === "fulfilled"
              ? groupsResult.value.find((item) => item.id === groupId)
              : null;
          if (refreshed) {
            const reloadedMember = refreshed.members.find(
              (item) =>
                item.memberId === activeMember.memberId || item.botId === activeMember.botId,
            );
            if (reloadedMember) {
              setActiveMember(reloadedMember);
              refreshedMember = reloadedMember;
            }
            onSaved(refreshed);
          }
        } catch {
          // ignore reload failure, still show conflict message
        }
        const message =
          error instanceof Error && error.message
            ? error.message
            : "This member's model changed. Reload the group.";
        const confirmed = refreshedMember ?? activeMember;
        setDraftKind(
          confirmed.runtimePin?.runtimeKind ??
            confirmed.effectiveRuntimePin?.runtimeKind ??
            botRuntimeKind ??
            bot?.runtimeKind ??
            "pi",
        );
        onError(t(message));
      } else {
        setDraftKind(
          activeMember.runtimePin?.runtimeKind ??
            activeMember.effectiveRuntimePin?.runtimeKind ??
            botRuntimeKind ??
            bot?.runtimeKind ??
            "pi",
        );
        // Say why the server refused the choice (for example a runtime this host cannot run); other
        // failures keep the generic sentence.
        const fallback = t("Could not save group model.");
        onError(error instanceof RpcError ? rpcErrorMessage(error, fallback) : fallback);
      }
    } finally {
      setPending(false);
    }
  }

  const inheritedPin =
    activeMember.effectiveRuntimePin ??
    (bot?.modelProvider && bot.modelId && bot.modelCredentialId
      ? {
          runtimeKind: bot.runtimeKind ?? "pi",
          provider: bot.modelProvider,
          modelId: bot.modelId,
          credentialId: bot.modelCredentialId,
          effort: bot.thinkingLevel ?? null,
        }
      : null);

  function changeRuntime(next: "pi" | "hermes") {
    setDraftKind(next);
    const pin = activeMember.runtimePin ?? inheritedPin;
    const pinCredential = pin?.credentialId
      ? credentials.find((item) => item.id === pin.credentialId)
      : undefined;
    if (
      !pin ||
      pin.runtimeKind === next ||
      !pin.provider ||
      !pin.modelId ||
      !pin.credentialId ||
      pin.credentialId.startsWith("native:") ||
      (next === "hermes" && Boolean(hermesConnectionRefusal(pin.provider, pinCredential)))
    )
      return;
    void choose({
      runtimeKind: next,
      provider: pin.provider,
      modelId: pin.modelId,
      credentialId: pin.credentialId,
      effort: pin.effort ?? null,
    });
  }

  const activePin = activeMember.runtimePin;
  const pinnedChoice =
    activePin?.provider && activePin.modelId && activePin.credentialId
      ? {
          runtimeKind: activePin.runtimeKind,
          provider: activePin.provider,
          modelId: activePin.modelId,
          credentialId: activePin.credentialId,
        }
      : null;
  const credential = credentials.find((item) => item.id === activePin?.credentialId);
  const entry = catalog.find(
    (item) => item.provider === activePin?.provider && item.id === activePin?.modelId,
  );
  const isOllama = activePin?.provider === "ollama";
  const supportedEfforts = credential?.thinkingLevels ?? entry?.thinkingLevels ?? [];
  const availableEfforts = supportedEfforts.filter((level) =>
    isOllama ? level === "off" || level === "medium" : level !== "off",
  );
  const defaultEffort =
    credential?.thinkingLevel ?? spaceDefaultEffort(undefined, supportedEfforts);
  const effortChoices = [
    ...(!isOllama && defaultEffort
      ? [{ effort: defaultEffort, label: `${t("Default")} (${effortLabel(defaultEffort, t)})` }]
      : []),
    ...(activePin?.effort && !availableEfforts.some((level) => level === activePin.effort)
      ? [{ effort: activePin.effort, label: effortLabel(activePin.effort, t) }]
      : []),
    ...availableEfforts.map((effort) => ({
      effort,
      label: isOllama ? (effort === "off" ? t("Off") : t("On")) : effortLabel(effort, t),
    })),
  ];
  const selectedEffortLabel = activePin?.effort
    ? isOllama
      ? activePin.effort === "off"
        ? t("Off")
        : t("On")
      : effortLabel(activePin.effort, t)
    : isOllama
      ? t("Off")
      : null;
  const label = activePin
    ? (choices.find(
        (choice) =>
          choice.pin.provider === activePin.provider &&
          choice.pin.modelId === activePin.modelId &&
          choice.pin.credentialId === activePin.credentialId,
      )?.label ?? activePin.modelId)
    : t("Same as bot");
  const currentOrInheritedPin = activePin ?? inheritedPin;
  const currentCredential = credentials.find(
    (item) => item.id === currentOrInheritedPin?.credentialId,
  );
  const hermesRefusal =
    draftKind === "hermes" && currentOrInheritedPin != null
      ? hermesConnectionRefusal(currentOrInheritedPin.provider, currentCredential)
      : undefined;
  return (
    <>
      {experimental ||
      draftKind !== "pi" ||
      (activeMember.runtimePin?.runtimeKind && activeMember.runtimePin.runtimeKind !== "pi") ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t("Runtime")} · ${activeMember.name}`}
          disabled={!activeMember.memberId || pending}
          onPress={() =>
            presentMessageActionSheet({
              title: t("Runtime"),
              cancel: t("Cancel"),
              more: t("More"),
              colorScheme,
              actions: [
                { text: t("Ardur (built-in)"), onPress: () => changeRuntime("pi") },
                ...(experimental
                  ? [{ text: t("Hermes"), onPress: () => changeRuntime("hermes") }]
                  : []),
              ],
            })
          }
          style={{ paddingVertical: 12 }}
        >
          <Text style={{ color: tokens.mutedForeground }}>{t("Runtime")}</Text>
          <Text style={{ color: tokens.foreground }}>{t(runtimeLabels[draftKind])}</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("Model in this group")} · ${activeMember.name}`}
        disabled={!activeMember.memberId || activeMember.modelPinRevision == null || pending}
        onPress={() =>
          presentMessageActionSheet({
            title: `${t("Model in this group")} · ${activeMember.name}`,
            cancel: t("Cancel"),
            more: t("More"),
            colorScheme,
            actions: [
              { text: t("Same as bot"), onPress: () => void choose(null) },
              ...choices.map((choice) => ({
                text: choice.label,
                onPress: () => void choose(choice.pin),
              })),
            ],
          })
        }
        style={{ paddingVertical: 12 }}
      >
        <Text style={{ color: tokens.mutedForeground }}>
          {t("Model in this group")} · {activeMember.name}
        </Text>
        <Text style={{ color: tokens.foreground }}>
          {label}
          {selectedEffortLabel ? ` · ${selectedEffortLabel}` : ""}
        </Text>
      </Pressable>
      {hermesRefusal ? (
        <Text style={{ color: tokens.mutedForeground }}>
          {hermesRefusalMessage(hermesRefusal, t)}
        </Text>
      ) : null}
      {pinnedChoice && effortChoices.length ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t("Thinking")} · ${activeMember.name}`}
          disabled={!activeMember.memberId || activeMember.modelPinRevision == null || pending}
          onPress={() =>
            presentMessageActionSheet({
              title: t("Thinking"),
              cancel: t("Cancel"),
              more: t("More"),
              colorScheme,
              actions: effortChoices.map((choice) => ({
                text: choice.label,
                onPress: () =>
                  void choose(
                    { ...pinnedChoice, runtimeKind: draftKind, effort: choice.effort },
                    false,
                  ),
              })),
            })
          }
          style={{ paddingVertical: 12 }}
        >
          <Text style={{ color: tokens.mutedForeground }}>{t("Thinking")}</Text>
          <Text style={{ color: tokens.foreground }}>{selectedEffortLabel}</Text>
        </Pressable>
      ) : null}
    </>
  );
}
