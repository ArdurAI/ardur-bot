import type { GroupMember, SetGroupMemberModelPinInput } from "@ardurbot/contracts";
import { spaceDefaultEffort } from "@ardurbot/core";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import type { MobileGroup, MobileModel, MobileModelCredential } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { RpcError } from "../lib/rpc-error";

type Choice = { label: string; pin: SetGroupMemberModelPinInput["pin"] };

export function GroupMemberModelControl({
  groupId,
  member,
  catalog,
  credentials,
  onSaved,
  onError,
}: {
  groupId: string;
  member: GroupMember;
  catalog: MobileModel[];
  credentials: MobileModelCredential[];
  onSaved: (group: MobileGroup) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const [pending, setPending] = useState(false);
  const [activeMember, setActiveMember] = useState(member);

  useEffect(() => {
    setActiveMember(member);
  }, [member]);

  const choices = useMemo<Choice[]>(() => {
    const currentPin = activeMember.runtimePin;
    const result: Choice[] = [];
    for (const credential of credentials) {
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
            runtimeKind: "pi",
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
            runtimeKind: "pi",
            provider: credential.provider,
            modelId: credential.modelId,
            credentialId: credential.id,
            effort: matchesCurrent ? currentPin.effort : defaultEffort,
          },
        });
      }
    }
    return result;
  }, [catalog, credentials, activeMember.runtimePin]);

  async function choose(pin: Choice["pin"] | null) {
    if (!activeMember.memberId || activeMember.modelPinRevision == null || pending) return;
    const currentPin = activeMember.runtimePin;
    const resolvedPin =
      pin &&
      currentPin &&
      pin.provider === currentPin.provider &&
      pin.modelId === currentPin.modelId &&
      pin.credentialId === currentPin.credentialId
        ? { ...pin, effort: currentPin.effort }
        : pin;
    setPending(true);
    onError("");
    try {
      const target = {
        groupId,
        botId: activeMember.botId,
        memberId: activeMember.memberId,
        expectedRevision: activeMember.modelPinRevision,
      };
      const group = await rpc<MobileGroup>(
        resolvedPin ? "groups/setMemberModelPin" : "groups/clearMemberModelPin",
        resolvedPin ? { ...target, pin: resolvedPin } : target,
      );
      setActiveMember(
        group.members.find(
          (item) => item.memberId === activeMember.memberId || item.botId === activeMember.botId,
        ) ?? activeMember,
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
        try {
          const groups = await rpc<MobileGroup[]>("groups/list");
          const refreshed = Array.isArray(groups)
            ? groups.find((item) => item.id === groupId)
            : null;
          if (refreshed) {
            const reloadedMember = refreshed.members.find(
              (item) =>
                item.memberId === activeMember.memberId || item.botId === activeMember.botId,
            );
            if (reloadedMember) {
              setActiveMember(reloadedMember);
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
        onError(t(message));
      } else {
        onError(t("Could not save group model."));
      }
    } finally {
      setPending(false);
    }
  }

  const label = activeMember.runtimePin
    ? (choices.find(
        (choice) =>
          choice.pin.provider === activeMember.runtimePin?.provider &&
          choice.pin.modelId === activeMember.runtimePin?.modelId &&
          choice.pin.credentialId === activeMember.runtimePin?.credentialId,
      )?.label ?? activeMember.runtimePin.modelId)
    : t("Same as bot");
  return (
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
      <Text style={{ color: tokens.foreground }}>{label}</Text>
    </Pressable>
  );
}
