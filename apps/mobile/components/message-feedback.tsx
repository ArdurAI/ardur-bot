import type { MessageReaction } from "@ardurbot/contracts";
import { useState } from "react";
import { Button, Modal, TextInput, View } from "react-native";
import { t } from "../lib/i18n";
import { native } from "../lib/native";

export function MessageFeedback({
  onFeedback,
}: {
  onFeedback: (
    reaction: MessageReaction,
    edit?: { reason?: string; retract?: boolean },
  ) => Promise<void>;
}) {
  const [reaction, setReaction] = useState<MessageReaction | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(retract = false) {
    if (!reaction) return;
    setSaving(true);
    try {
      await onFeedback(reaction, { reason, retract });
      setReaction(null);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <View style={{ flexDirection: "row", alignSelf: "flex-start" }}>
        {(["👍", "👎"] as const).map((value) => (
          <Button
            key={value}
            title={value}
            accessibilityLabel={value}
            onPress={() => {
              setReaction(value);
              setReason("");
              void onFeedback(value);
            }}
          />
        ))}
      </View>
      <Modal
        visible={reaction !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setReaction(null)}
      >
        <View style={{ flex: 1, padding: 24, gap: 16, backgroundColor: native.page }}>
          <Button title={t("Cancel")} onPress={() => setReaction(null)} />
          <TextInput
            accessibilityLabel={reaction === "👎" ? t("What was wrong?") : t("What was good?")}
            placeholder={reaction === "👎" ? t("What was wrong?") : t("What was good?")}
            value={reason}
            onChangeText={(text) => setReason(text.replace(/[\r\n]/g, " "))}
            maxLength={500}
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            style={{ padding: 12, color: native.label, backgroundColor: native.fill }}
          />
          <Button title={t("Save")} disabled={saving} onPress={() => void save()} />
          <Button title={t("Remove feedback")} disabled={saving} onPress={() => void save(true)} />
        </View>
      </Modal>
    </>
  );
}
