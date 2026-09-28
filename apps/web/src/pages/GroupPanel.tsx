import {
  type Bot,
  type BotCommunicationPolicy,
  type Goal,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
  type Group,
  type GroupMember,
  runtimeNames,
  runtimeSupportsTools,
  type SetGroupMemberModelPinInput,
} from "@ardurbot/contracts";
import { BotAvatar, Button, Input, NativeSelect, NativeSelectOption } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
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
  }) => Promise<void>;
  onModelPin: (
    member: GroupMember,
    pin: SetGroupMemberModelPinInput["pin"] | null,
  ) => Promise<void>;
  onReloadMember?: (member: GroupMember) => Promise<GroupMember | undefined>;
  modelSettings: ModelSettings | null;
  onRemove: () => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const coordinatorId = useId();
  const [name, setName] = useState(group.name);
  const [coordinator, setCoordinator] = useState(group.coordinatorBotId ?? "");
  const [selected, setSelected] = useState(group.members.map((member) => member.botId));
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
    if (previous.id !== group.id) {
      setName(group.name);
      setCoordinator(group.coordinatorBotId ?? "");
      setSelected(group.members.map((member) => member.botId));
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
    return onSave({
      coordinatorBotId: selected.includes(coordinator) ? coordinator : null,
      name: name.trim() !== group.name ? name.trim() : undefined,
      botIds: sameMembers(
        selected,
        group.members.map((member) => member.botId),
      )
        ? undefined
        : selected,
    });
  }

  const coordinatorRuntime = coordinator
    ? (group.members.find((member) => member.botId === coordinator)?.effectiveRuntimePin
        ?.runtimeKind ??
      bots.find((bot) => bot.id === coordinator)?.runtimeKind ??
      "pi")
    : null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[13.5px] text-muted-foreground">
          <Trans>Group settings</Trans>
        </span>
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

export function GroupGoalStrip({ goal, onStop }: { goal: Goal; onStop: () => Promise<void> }) {
  const { t } = useLingui();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      <span className="truncate">
        <Trans>Goal</Trans>: {status} · {goal.usedTokens.toLocaleString()} /{" "}
        {goal.tokenLimit.toLocaleString()} <Trans>tokens</Trans> ·{" "}
        {new Date(goal.untilAt).toLocaleString()}
      </span>
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
