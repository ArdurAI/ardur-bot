import type {
  LearningJourneyEntry,
  LearningProposal,
  ProposalEvidence,
  SpaceLearningConfig,
} from "@ardurbot/contracts";
import {
  LearningJourneyEntrySchema,
  learningApprovalBlock,
  learningJourneyLabel,
} from "@ardurbot/contracts";
import { LOCAL_IMPORT_TOOL_NAMES } from "@ardurbot/contracts/local-import";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Button,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { LearningCurator } from "../lib/LearningCurator";
import { LearningObservations, LearningObservationView } from "../lib/LearningObservations";
import {
  learningAction,
  learningBeforeAfter,
  loadLearning,
  loadLearningEvidence,
  loadLearningProposal,
  loadLearningSettings,
} from "../lib/learning";
import { native, useThemedStyles } from "../lib/native";

export default function Learning() {
  const { t } = useI18n();
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  const styles = useThemedStyles(createStyles);
  const [timeline, setTimeline] = useState<LearningJourneyEntry[] | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<LearningJourneyEntry | null>(null);
  const [botNames, setBotNames] = useState<Record<string, string>>({});
  const [items, setItems] = useState<LearningProposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<LearningProposal | null>(null);
  const [counts, setCounts] = useState({ pendingCount: 0, appliedThisWeek: 0 });
  const [settings, setSettings] = useState<SpaceLearningConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<ProposalEvidence | null>(null);
  const [conflict, setConflict] =
    useState<Awaited<ReturnType<typeof learningAction>>["conflict"]>();
  const load = useCallback(async () => {
    const [inbox, config, proposal] = await Promise.all([
      loadLearning(botId),
      loadLearningSettings(),
      selectedId ? loadLearningProposal(selectedId) : null,
    ]);
    setItems(inbox.proposals);
    setSelected(proposal);
    setBotNames(inbox.botNames);
    setCounts(inbox);
    setSettings(config);
  }, [botId, selectedId]);
  useFocusEffect(
    useCallback(() => {
      void load().catch(() => setError(true));
      const timer = setInterval(() => {
        if (!busyRef.current) void load().catch(() => undefined);
      }, 15000);
      return () => clearInterval(timer);
    }, [load]),
  );
  async function change(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await action();
      await load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{t("What I learned")}</Text>
        {settings && !settings.enabled ? (
          <Text style={styles.secondary}>{t("Learning is off for this space.")}</Text>
        ) : null}
        {settings?.canConfigure ? (
          <Switch
            accessibilityLabel={t("Learning")}
            value={settings.enabled}
            disabled={busy}
            onValueChange={(enabled) =>
              void change(() =>
                rpc("learning/configure", {
                  enabled,
                  consolidationEnabled: settings.consolidationEnabled,
                  reviewerPin: settings.reviewerPin ?? settings.destination,
                  budgets: settings.budgets,
                }),
              )
            }
          />
        ) : null}
        {!settings?.enabled && settings?.canConfigure ? (
          <Text style={styles.secondary}>
            {settings.destination?.provider} · {settings.destination?.modelId} ·{" "}
            {settings.destination?.effort}
          </Text>
        ) : null}
        {settings?.canConfigure ? (
          <LearningCurator settings={settings} busy={busy} change={change} />
        ) : null}
        {counts.pendingCount > 0 ? (
          <Text style={styles.secondary}>
            {counts.pendingCount} {t("suggestions to review")}
          </Text>
        ) : null}
        {counts.appliedThisWeek > 0 ? (
          <Text style={styles.secondary}>
            {t("learned")} {counts.appliedThisWeek} {t("things this week")}
          </Text>
        ) : null}
        {error ? (
          <View>
            <Text accessibilityRole="alert" style={styles.error}>
              {t("Could not update learning. Try again.")}
            </Text>
            <Button title={t("Retry")} onPress={() => void change(load)} />
          </View>
        ) : null}
        {busy ? <ActivityIndicator /> : null}
        {!items.length && settings ? (
          <Text style={styles.secondary}>{t("Nothing to review.")}</Text>
        ) : null}
        <Button
          title={timeline ? t("Inbox") : t("Timeline")}
          onPress={() =>
            void change(async () => {
              if (timeline) setTimeline(null);
              else
                setTimeline(
                  LearningJourneyEntrySchema.array().parse(
                    await rpc("learning/journey", { botId }),
                  ),
                );
            })
          }
        />
        {timeline
          ? timeline.map((entry) => (
              <View key={entry.id} style={styles.card}>
                <Text style={styles.body}>
                  {entry.importedFrom
                    ? t(
                        entry.action === "import-removed"
                          ? "Removed import from {tool}"
                          : "Imported from {tool}",
                        { tool: LOCAL_IMPORT_TOOL_NAMES[entry.importedFrom] },
                      )
                    : t(learningJourneyLabel(entry.action))}{" "}
                  · {entry.at}
                </Text>
                {entry.proposalId ? (
                  <Button
                    title={t("Proposal")}
                    onPress={() => {
                      setTimeline(null);
                      setSelectedId(entry.proposalId!);
                      setOpen(entry.proposalId!);
                    }}
                  />
                ) : null}
                {entry.revisionId ? (
                  <Button
                    title={`${t("Revision and observations")} ${entry.revisionId}`}
                    onPress={() => setSelectedRevision(entry)}
                  />
                ) : null}
              </View>
            ))
          : null}
        {timeline && selectedRevision?.documentId && selectedRevision.revisionId ? (
          <LearningObservations
            documentId={selectedRevision.documentId}
            revision={Number(selectedRevision.revisionId.split(":").at(-1))}
          />
        ) : null}
        {!timeline &&
          [...(selected ? [selected] : []), ...items.filter((p) => p.id !== selected?.id)].map(
            (proposal) => {
              const blocked = learningApprovalBlock(proposal);
              const diff = learningBeforeAfter(proposal.diff);
              return (
                <View key={proposal.id} style={styles.card}>
                  <Text numberOfLines={1} style={styles.title}>
                    {proposal.operation === "revert-suggestion"
                      ? t("Possible regression — review undo")
                      : proposal.operation === "consolidation"
                        ? t("Proposed consolidation")
                        : proposal.type === "policy-suggestion"
                          ? proposal.rationale
                          : proposal.type === "board-item"
                            ? proposal.boardItem?.title
                            : (proposal.proposedContent
                                ?.split("\n")
                                .find((line) => line.trim() && line !== "---") ??
                              proposal.typedDelta?.key ??
                              proposal.type)}
                  </Text>
                  <Text style={styles.secondary}>
                    {proposal.scope.botId
                      ? `${t("Bot")}: ${botNames[proposal.scope.botId] ?? proposal.scope.botId}`
                      : t("Personal")}
                  </Text>
                  <View style={styles.actions}>
                    {proposal.status === "pending" ? (
                      <>
                        <Button
                          title={t("Approve")}
                          disabled={busy || !!blocked}
                          onPress={() => void change(() => learningAction("approve", proposal.id))}
                        />
                        <Button
                          title={t("Reject")}
                          disabled={busy}
                          onPress={() =>
                            void change(async () => {
                              const result = await learningAction("reject", proposal.id);
                              setConflict(result.conflict);
                              setOpen(proposal.id);
                            })
                          }
                        />
                      </>
                    ) : proposal.status === "applied" ? (
                      <>
                        <Text style={styles.body}>{t("Applied")}</Text>
                        {proposal.appliedRevisionId || proposal.appliedBoardItem ? (
                          <Button
                            title={t("Undo")}
                            disabled={busy}
                            onPress={() =>
                              void change(async () => {
                                const result = await learningAction("revert", proposal.id);
                                setConflict(result.conflict);
                                setOpen(proposal.id);
                              })
                            }
                          />
                        ) : null}
                      </>
                    ) : (
                      <Text style={styles.secondary}>
                        {proposal.status === "reverted" ? t("Undone") : proposal.status}
                      </Text>
                    )}
                  </View>
                  {blocked ? <Text style={styles.secondary}>{t(blocked)}</Text> : null}
                  <Button
                    title={t("Details")}
                    onPress={() => {
                      setOpen(open === proposal.id ? null : proposal.id);
                      setEvidence(null);
                      setConflict(undefined);
                    }}
                  />
                  {open === proposal.id ? (
                    <View>
                      <Text style={styles.title}>{t("Before")}</Text>
                      <Text selectable style={styles.body}>
                        {diff.before}
                      </Text>
                      <Text style={styles.title}>{t("After")}</Text>
                      <Text selectable style={styles.body}>
                        {diff.after}
                      </Text>
                      <Text style={styles.body}>{proposal.rationale}</Text>
                      {proposal.observation ? (
                        <LearningObservationView observation={proposal.observation} />
                      ) : null}
                      {proposal.boardOutcome ? (
                        <Text style={styles.secondary}>
                          {proposal.boardOutcome.outcome === "completed"
                            ? t("This board item was completed.")
                            : proposal.boardOutcome.outcome === "closed-other"
                              ? proposal.boardOutcome.closeReason
                                ? t(
                                    "This board item was closed without being completed: {reason}. Review it on the Board.",
                                    { reason: proposal.boardOutcome.closeReason },
                                  )
                                : t(
                                    "This board item was closed without being completed. Review it on the Board.",
                                  )
                              : t("This board item is still open.")}
                        </Text>
                      ) : null}
                      {proposal.confidence ? (
                        <Text style={styles.secondary}>
                          {t("model estimate")}: {Math.round(proposal.confidence.value * 100)}%
                        </Text>
                      ) : null}
                      {proposal.provenance ? (
                        <Text style={styles.secondary}>
                          {proposal.provenance.runId} ·{" "}
                          {proposal.provenance.originatingPin?.modelId} ·{" "}
                          {proposal.provenance.reviewerPin.modelId} ·{" "}
                          {proposal.provenance.reviewerPin.effort} ·{" "}
                          {proposal.provenance.policyVersion}
                        </Text>
                      ) : null}
                      {proposal.evidenceIds.map((id) => (
                        <Button
                          key={id}
                          disabled={busy}
                          title={`${t("Evidence")} ${id.slice(0, 8)}`}
                          onPress={() =>
                            void change(async () =>
                              setEvidence(await loadLearningEvidence(proposal.id, id)),
                            )
                          }
                        />
                      ))}
                      {evidence ? (
                        <Text selectable style={styles.body}>
                          {evidence.excerpt ??
                            `${evidence.outcome?.category}: ${evidence.outcome?.classification}`}
                        </Text>
                      ) : null}
                      {proposal.documentId && proposal.appliedRevisionId ? (
                        <LearningObservations
                          documentId={proposal.documentId}
                          revision={Number(proposal.appliedRevisionId.split(":").at(-1))}
                        />
                      ) : null}
                      {proposal.participatingRevisions?.map((r) => (
                        <Text key={r.documentId} style={styles.secondary}>
                          {t("Source revision")}: {r.documentId}:{r.revision}
                        </Text>
                      ))}
                      {conflict ? (
                        <View>
                          <Text style={styles.error}>
                            {proposal.type === "board-item"
                              ? conflict.current ||
                                t(
                                  "This board item changed after it was filed. Review it on the Board.",
                                )
                              : t(
                                  "Later edits overlap this change. Review both versions in History.",
                                )}
                          </Text>
                          {proposal.type === "board-item" ? null : (
                            <>
                              <Text style={styles.title}>{t("Before")}</Text>
                              <Text selectable style={styles.body}>
                                {conflict.before}
                              </Text>
                              <Text style={styles.title}>{t("Applied")}</Text>
                              <Text selectable style={styles.body}>
                                {conflict.applied}
                              </Text>
                              <Text style={styles.title}>{t("Current")}</Text>
                              <Text selectable style={styles.body}>
                                {conflict.current}
                              </Text>
                            </>
                          )}
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            },
          )}
      </ScrollView>
    </SafeAreaView>
  );
}
function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 12 },
    card: { borderWidth: 1, borderColor: tokens.border, borderRadius: 12, padding: 12, gap: 8 },
    title: { fontSize: 16, fontWeight: "600", color: native.label },
    secondary: { fontSize: 13, color: native.secondaryLabel },
    body: { fontSize: 14, color: native.label },
    error: { color: tokens.destructive },
    actions: { flexDirection: "row", alignItems: "center", minHeight: 44, gap: 8 },
  });
}
