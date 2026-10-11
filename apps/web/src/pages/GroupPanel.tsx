import type {
  Bot,
  BotCommunicationPolicy,
  Goal,
  Group,
  GroupMember,
  RoomPolicyPatch,
  SetGroupMemberModelPinInput,
} from "@ardurbot/contracts";
import {
  GOAL_FINAL_REVIEW_DESCRIPTION,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
  parseRoomPolicy,
  ROOM_POLICY_MAX_CONCURRENT_RUNS_MAX,
  ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN,
  runtimeNames,
  runtimeSupportsTools,
} from "@ardurbot/contracts";
import { BotAvatar, Button, Input, NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { Check, X } from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BotContext } from "../components/ContextEntry";
import { rpc } from "../lib/rpc";
import type { ModelSettings } from "../lib/use-model-settings";
import { GroupModelControl } from "./group-model-control";

const StartGoalForm = lazy(() =>
  import("./GoalForm").then((module) => ({ default: module.StartGoalForm })),
);

function validSelection(name: string, selected: readonly string[]) {
  return (
    Boolean(name.trim()) &&
    selected.length >= GROUP_MEMBER_MIN &&
    selected.length <= GROUP_MEMBER_MAX
  );
}

function sameMembers(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

function MemberPicker({
  bots,
  selected,
  onChange,
  maxHeight,
}: {
  bots: Bot[];
  selected: string[];
  onChange: (selected: string[]) => void;
  maxHeight: "max-h-[240px]" | "max-h-[280px]";
}) {
  const selectable = useMemo(() => bots.filter((bot) => !bot.archivedAt), [bots]);

  function toggle(botId: string) {
    if (selected.includes(botId)) {
      onChange(selected.filter((id) => id !== botId));
    } else if (selected.length < GROUP_MEMBER_MAX) {
      onChange([...selected, botId]);
    }
  }

  return (
    <div className={`mt-2 ${maxHeight} space-y-1 overflow-y-auto`}>
      {selectable.map((bot) => {
        const checked = selected.includes(bot.id);
        return (
          <button
            key={bot.id}
            type="button"
            aria-pressed={checked}
            onClick={() => toggle(bot.id)}
            className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start ${
              checked ? "bg-muted" : "hover:bg-accent"
            }`}
          >
            <BotAvatar
              color={bot.color}
              identity={bot.id}
              label={bot.name}
              size={32}
              status={bot.status}
            />
            <span className="flex-1 text-[15px] text-foreground" dir="auto">
              {bot.name}
            </span>
            {checked ? <Check size={14} className="text-muted-foreground" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function CreateGroupForm({
  bots,
  onCancel,
  onCreate,
}: {
  bots: Bot[];
  onCancel: () => void;
  onCreate: (input: { name: string; botIds: string[] }) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    if (submitting || !validSelection(name, selected)) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), botIds: selected });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not create group`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>New group</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Cancel new group`}
          onClick={onCancel}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-sm text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t`Name this group`}
          className="mt-2"
        />
      </label>
      <div className="mt-5 text-sm text-muted-foreground">
        <Trans>
          Members (pick {GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
        </Trans>
      </div>
      <MemberPicker
        bots={bots}
        selected={selected}
        onChange={setSelected}
        maxHeight="max-h-[280px]"
      />
      <Button
        className="mt-5 w-full"
        disabled={submitting || !validSelection(name, selected)}
        onClick={() => void create()}
      >
        {submitting ? <Trans>Creating…</Trans> : <Trans>Create group</Trans>}
      </Button>
    </div>
  );
}

export function GroupSettings({
  group,
  bots,
  goal,
  canManageGoal,
  onStartGoal,
  onSave,
  onModelPin,
  onReloadMember,
  modelSettings,
  onRemove,
}: {
  group: Group;
  bots: Bot[];
  goal: Goal | null;
  canManageGoal: boolean;
  onStartGoal: (input: {
    groupId: string;
    objective: string;
    doneWhen: string[];
    untilAt?: string;
    tokenLimit: number;
  }) => Promise<void>;
  onSave: (input: {
    name?: string;
    botIds?: string[];
    coordinatorBotId?: string | null;
    roomPolicy?: RoomPolicyPatch;
  }) => Promise<void>;
  onModelPin: (
    member: GroupMember,
    pin: SetGroupMemberModelPinInput["pin"] | null,
    expectedBotModelPinRevision?: number,
  ) => Promise<void>;
  onReloadMember?: (member: GroupMember) => Promise<GroupMember | undefined>;
  modelSettings: ModelSettings | null;
  onRemove: () => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const coordinatorId = useId();
  const concurrencyId = useId();
  const [name, setName] = useState(group.name);
  const [coordinator, setCoordinator] = useState(group.coordinatorBotId ?? "");
  const [selected, setSelected] = useState(group.members.map((member) => member.botId));
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(
    parseRoomPolicy(group.roomPolicy).maxConcurrentRuns,
  );
  const baseline = useRef(group);
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spaceTraffic, setSpaceTraffic] = useState<BotCommunicationPolicy | null>(null);
  const [groupTraffic, setGroupTraffic] = useState<BotCommunicationPolicy | null>(null);
  const [trafficBusy, setTrafficBusy] = useState(false);

  useEffect(() => {
    if (!canManageGoal) return;
    let active = true;
    void Promise.all([rpc.botComms.getPolicy({}), rpc.botComms.getPolicy({ groupId: group.id })])
      .then(([space, groupPolicy]) => {
        if (active) {
          setSpaceTraffic(space);
          setGroupTraffic(groupPolicy);
        }
      })
      .catch(() => {
        if (active) setError(t`Could not load team message controls`);
      });
    return () => {
      active = false;
    };
  }, [canManageGoal, group.id, t]);

  async function setTrafficPaused(policy: BotCommunicationPolicy, paused: boolean) {
    if (trafficBusy) return;
    setTrafficBusy(true);
    setError(null);
    try {
      await rpc.botComms.setPaused({
        scope: policy.scope,
        ...(policy.groupId ? { groupId: policy.groupId } : {}),
        paused,
        expectedRevision: policy.revision,
      });
      const [space, groupPolicy] = await Promise.all([
        rpc.botComms.getPolicy({}),
        rpc.botComms.getPolicy({ groupId: group.id }),
      ]);
      setSpaceTraffic(space);
      setGroupTraffic(groupPolicy);
    } catch {
      setError(t`Could not update team messages`);
    } finally {
      setTrafficBusy(false);
    }
  }

  useLayoutEffect(() => {
    const previous = baseline.current;
    if (previous === group) return;
    baseline.current = group;
    const effectiveConcurrency = (value: Group) =>
      parseRoomPolicy(value.roomPolicy).maxConcurrentRuns;
    if (previous.id !== group.id) {
      setName(group.name);
      setCoordinator(group.coordinatorBotId ?? "");
      setSelected(group.members.map((member) => member.botId));
      setMaxConcurrentRuns(effectiveConcurrency(group));
      return;
    }
    setName((current) => (current === previous.name ? group.name : current));
    setCoordinator((current) =>
      current === (previous.coordinatorBotId ?? "") ? (group.coordinatorBotId ?? "") : current,
    );
    setSelected((current) =>
      sameMembers(
        current,
        previous.members.map((member) => member.botId),
      )
        ? group.members.map((member) => member.botId)
        : current,
    );
    setMaxConcurrentRuns((current) =>
      current === effectiveConcurrency(previous) ? effectiveConcurrency(group) : current,
    );
  }, [group]);

  async function mutate(kind: "save" | "remove", action: () => Promise<void>) {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : kind === "save"
            ? t`Could not save group`
            : t`Could not remove group`,
      );
    } finally {
      setPending(null);
    }
  }

  function save() {
    const stored = parseRoomPolicy(group.roomPolicy);
    return onSave({
      coordinatorBotId: selected.includes(coordinator) ? coordinator : null,
      name: name.trim() !== group.name ? name.trim() : undefined,
      botIds: sameMembers(
        selected,
        group.members.map((member) => member.botId),
      )
        ? undefined
        : selected,
      roomPolicy:
        maxConcurrentRuns !== stored.maxConcurrentRuns ? { maxConcurrentRuns } : undefined,
    });
  }

  const coordinatorRuntime =
    coordinator && selected.includes(coordinator)
      ? (group.members.find((member) => member.botId === coordinator)?.effectiveRuntimePin
          ?.runtimeKind ??
        bots.find((bot) => bot.id === coordinator)?.runtimeKind ??
        "pi")
      : null;

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <label htmlFor={nameId} className="block text-sm text-muted-foreground">
        <Trans>Name</Trans>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-2"
        />
      </label>
      <div className="mt-5 text-sm text-muted-foreground">
        <Trans>
          Members ({GROUP_MEMBER_MIN}–{GROUP_MEMBER_MAX})
        </Trans>
      </div>
      <MemberPicker
        bots={bots}
        selected={selected}
        onChange={setSelected}
        maxHeight="max-h-[240px]"
      />
      {selected.map((botId) => {
        const bot = bots.find((entry) => entry.id === botId);
        if (!bot) return null;
        return (
          <GroupModelControl
            key={botId}
            member={group.members.find((entry) => entry.botId === botId)}
            bot={bot}
            settings={modelSettings}
            onSave={onModelPin}
            onReload={onReloadMember}
          />
        );
      })}
      <label htmlFor={coordinatorId} className="mt-4 block text-sm text-muted-foreground">
        <Trans>Coordinator</Trans>
        <NativeSelect
          id={coordinatorId}
          aria-label={t`Coordinator`}
          value={selected.includes(coordinator) ? coordinator : ""}
          onChange={(event) => setCoordinator(event.target.value)}
        >
          <NativeSelectOption value="">
            <Trans>None</Trans>
          </NativeSelectOption>
          {bots
            .filter((bot) => selected.includes(bot.id))
            .map((bot) => (
              <NativeSelectOption key={bot.id} value={bot.id}>
                {bot.name}
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </label>
      {coordinatorRuntime && !runtimeSupportsTools(coordinatorRuntime) ? (
        <p className="mt-2 text-[13px] text-warning" data-testid="coordinator-tools-warning">
          <Trans>
            {runtimeNames[coordinatorRuntime]} can't use Ardur tools — a coordinator needs tools to
            hand off work.
          </Trans>
        </p>
      ) : null}
      <label htmlFor={concurrencyId} className="mt-4 block text-sm text-muted-foreground">
        <Trans>Bots answering at once</Trans>
        <NativeSelect
          id={concurrencyId}
          aria-label={t`Bots answering at once`}
          value={String(maxConcurrentRuns)}
          onChange={(event) => setMaxConcurrentRuns(Number(event.target.value))}
        >
          {Array.from(
            {
              length: ROOM_POLICY_MAX_CONCURRENT_RUNS_MAX - ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN + 1,
            },
            (_, index) => ROOM_POLICY_MAX_CONCURRENT_RUNS_MIN + index,
          ).map((value) => (
            <NativeSelectOption key={value} value={String(value)}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <Button
        className="mt-5 w-full"
        disabled={pending !== null || !validSelection(name, selected)}
        onClick={() => void mutate("save", save)}
      >
        {pending === "save" ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
      </Button>
      {canManageGoal &&
      group.coordinatorBotId &&
      (!goal || goal.status === "stopped" || goal.status === "exhausted") ? (
        <Suspense fallback={null}>
          <StartGoalForm groupId={group.id} onStart={onStartGoal} />
        </Suspense>
      ) : null}
      {canManageGoal && spaceTraffic && groupTraffic ? (
        <div className="mt-5 space-y-2" data-testid="peer-traffic-controls">
          <Button
            variant="outline"
            className="w-full"
            disabled={trafficBusy}
            onClick={() => void setTrafficPaused(spaceTraffic, !spaceTraffic.paused)}
          >
            {spaceTraffic.paused ? (
              <Trans>Resume team messages</Trans>
            ) : (
              <Trans>Pause team messages</Trans>
            )}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={trafficBusy}
            onClick={() => void setTrafficPaused(groupTraffic, !groupTraffic.paused)}
          >
            {groupTraffic.paused ? (
              <Trans>Resume group messages</Trans>
            ) : (
              <Trans>Pause group messages</Trans>
            )}
          </Button>
        </div>
      ) : null}
      <div className="mt-4 text-sm text-muted-foreground">
        <Trans>Context</Trans>
      </div>
      {group.members.map((member) => (
        <BotContext
          key={member.botId}
          botId={member.botId}
          groupId={group.id}
          label={member.name}
          showSettings={false}
        />
      ))}
      <Button
        variant="destructive"
        className="mt-4 w-full"
        disabled={pending !== null}
        onClick={() => void mutate("remove", onRemove)}
      >
        {pending === "remove" ? <Trans>Deleting…</Trans> : <Trans>Delete group</Trans>}
      </Button>
    </div>
  );
}

export function GroupGoalStrip({
  goal,
  onStop,
  onRefresh,
}: {
  goal: Goal;
  onStop: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [stopping, setStopping] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [notes, setNotes] = useState("");
  const reviewPending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  async function markCondition(conditionId: string, status: "pass" | "fail") {
    if (!goal.currentRevision || reviewPending.current) return;
    reviewPending.current = true;
    setReviewing(true);
    setError(null);
    try {
      await rpc.goals.reviewCondition({
        goalId: goal.id,
        revisionId: goal.currentRevision.id,
        conditionId,
        status,
      });
      await onRefresh();
    } catch (cause) {
      const reason = cause instanceof ORPCError ? cause.data?.reason : undefined;
      setError(
        reason === "revision-changed"
          ? t`Result changed; review again.`
          : t`Could not review result. Try again.`,
      );
      if (reason === "revision-changed") await onRefresh().catch(() => undefined);
    } finally {
      reviewPending.current = false;
      setReviewing(false);
    }
  }
  async function review(action: "accept" | "reject") {
    if (!goal.currentRevision || reviewPending.current) return;
    const reworkNotes = notes.trim();
    if (action === "reject" && !reworkNotes) return;
    reviewPending.current = true;
    setReviewing(true);
    setError(null);
    try {
      const input = { goalId: goal.id, revisionId: goal.currentRevision.id };
      if (action === "accept") await rpc.goals.accept(input);
      else await rpc.goals.reject({ ...input, reworkNotes });
      await onRefresh();
    } catch (cause) {
      const reason = cause instanceof ORPCError ? cause.data?.reason : undefined;
      setError(
        reason === "revision-changed"
          ? t`Result changed; review again.`
          : reason === "work-active"
            ? t`Work is still active.`
            : reason === "conditions-open"
              ? t`Every condition must pass.`
              : t`Could not review result. Try again.`,
      );
      if (reason === "revision-changed") await onRefresh().catch(() => undefined);
    } finally {
      reviewPending.current = false;
      setReviewing(false);
    }
  }
  const status =
    goal.status === "running"
      ? t`Working`
      : goal.status === "stopped"
        ? t`Stopped`
        : goal.status === "exhausted"
          ? t`Exhausted`
          : goal.status === "completed"
            ? t`Completed`
            : goal.status === "accepted"
              ? t`Accepted`
              : goal.status === "paused"
                ? t`Paused`
                : goal.status === "blocked"
                  ? t`Blocked`
                  : t`Needs you`;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-1 text-xs text-muted-foreground md:px-[22px]">
      <details className="min-w-0 flex-1">
        <summary className="cursor-pointer truncate">
          <Trans>Goal</Trans>: {status} · {goal.usedTokens?.toLocaleString() ?? t`Unknown`} /{" "}
          {goal.tokenLimit.toLocaleString()} <Trans>tokens</Trans> ·{" "}
          {new Date(goal.untilAt).toLocaleString()}
        </summary>
        {goal.status === "completed" && goal.currentRevision ? (
          <div className="py-2 border-b border-border mb-2">
            <h4 className="font-semibold mb-1">
              <Trans>Review result</Trans>
            </h4>
            <p className="text-sm mb-2">{goal.currentRevision.summary}</p>
            <ul className="text-sm list-disc pl-4 mb-3">
              {goal.currentRevision.conditions.map((cond) => (
                <li key={cond.id} className="mb-1">
                  {cond.description === GOAL_FINAL_REVIEW_DESCRIPTION || cond.id === "cond-final"
                    ? t`Final owner review`
                    : cond.description}
                  :
                  {cond.status === "pass" ? (
                    <span className="text-success ml-1">
                      <Trans>Pass</Trans>
                    </span>
                  ) : cond.status === "fail" ? (
                    <span className="text-destructive ml-1">
                      <Trans>Fail</Trans>
                    </span>
                  ) : (
                    <span className="text-muted-foreground ml-1">
                      <Trans>Unknown</Trans>
                    </span>
                  )}
                  <span className="ml-2 inline-flex gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={reviewing}
                      onClick={() => void markCondition(cond.id, "pass")}
                    >
                      <Trans>Pass</Trans>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={reviewing}
                      onClick={() => void markCondition(cond.id, "fail")}
                    >
                      <Trans>Fail</Trans>
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
            <textarea
              aria-label={t`Rework notes`}
              value={notes}
              rows={2}
              maxLength={4000}
              disabled={reviewing}
              onChange={(event) => setNotes(event.target.value)}
              className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={reviewing}
                onClick={() => void review("accept")}
              >
                <Trans>Accept result</Trans>
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={reviewing || notes.trim().length === 0}
                onClick={() => void review("reject")}
              >
                <Trans>Reject result</Trans>
              </Button>
            </div>
          </div>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 py-2">
          <dt>
            <Trans>Used</Trans>
          </dt>
          <dd>{goal.usedTokens?.toLocaleString() ?? t`Unknown`}</dd>
          <dt>
            <Trans>Reserved</Trans>
          </dt>
          <dd>{goal.reservedTokens?.toLocaleString() ?? t`Unknown`}</dd>
          <dt>
            <Trans>Available</Trans>
          </dt>
          <dd>{goal.availableTokens?.toLocaleString() ?? t`Unknown`}</dd>
        </dl>
        {!goal.usageComplete ? (
          <p className="pb-2">
            <Trans>Usage incomplete</Trans>
          </p>
        ) : null}
      </details>
      {goal.status === "running" ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            setError(null);
            void onStop()
              .catch(() => setError(t`Could not stop goal. Try again.`))
              .finally(() => setStopping(false));
          }}
        >
          <Trans>Stop</Trans>
        </Button>
      ) : null}
      {error ? (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function memberName(
  members: Group["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}
