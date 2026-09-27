import type { GroupMember, SetGroupMemberModelPinInput } from "@ardurbot/contracts";
import { spaceDefaultEffort } from "@ardurbot/core";
import { useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import type { MobileGroup, MobileModel, MobileModelCredential } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

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
  const choices = useMemo<Choice[]>(() => {
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
        result.push({
          label: `${hasSeveralConnections ? credential.label : (entry.providerName ?? entry.provider)} · ${entry.label}`,
          pin: {
            runtimeKind: "pi",
            provider: entry.provider,
            modelId: entry.id,
            credentialId: credential.id,
            effort:
              entry.provider === "ollama" && (credential.reasoning ?? entry.reasoning) === false
                ? null
                : (credential.thinkingLevel ??
                  spaceDefaultEffort(
                    credential.reasoning ?? entry.reasoning,
                    credential.thinkingLevels ?? entry.thinkingLevels,
                  )),
          },
        });
      }
      if (credential.provider === "openai-compatible" && credential.modelId) {
        result.push({
          label: `${credential.label} · ${credential.modelId}`,
          pin: {
            runtimeKind: "pi",
            provider: credential.provider,
            modelId: credential.modelId,
            credentialId: credential.id,
            effort:
              credential.thinkingLevel ??
              spaceDefaultEffort(credential.reasoning, credential.thinkingLevels),
          },
        });
      }
    }
    return result;
  }, [catalog, credentials]);

  async function choose(pin: Choice["pin"] | null) {
    if (!member.memberId || member.modelPinRevision == null || pending) return;
    setPending(true);
    onError("");
    try {
      const target = {
        groupId,
        botId: member.botId,
        memberId: member.memberId,
        expectedRevision: member.modelPinRevision,
      };
      const group = await rpc<MobileGroup>(
        pin ? "groups/setMemberModelPin" : "groups/clearMemberModelPin",
        pin ? { ...target, pin } : target,
      );
      onSaved(group);
    } catch {
      onError(t("Could not save group model."));
    } finally {
      setPending(false);
    }
  }

  const label = member.runtimePin
    ? (choices.find(
        (choice) =>
          choice.pin.provider === member.runtimePin?.provider &&
          choice.pin.modelId === member.runtimePin?.modelId &&
          choice.pin.credentialId === member.runtimePin?.credentialId,
      )?.label ?? member.runtimePin.modelId)
    : t("Same as bot");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t("Model in this group")} · ${member.name}`}
      disabled={!member.memberId || member.modelPinRevision == null || pending}
      onPress={() =>
        presentMessageActionSheet({
          title: `${t("Model in this group")} · ${member.name}`,
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
        {t("Model in this group")} · {member.name}
      </Text>
      <Text style={{ color: tokens.foreground }}>{label}</Text>
    </Pressable>
  );
}
