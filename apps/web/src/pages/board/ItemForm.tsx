import type { Bot } from "@ardurbot/contracts";
import type { BoardCreate, BoardPatch, WorkItem } from "@ardurbot/contracts/board";
import { BOARD_TYPES } from "@ardurbot/contracts/board";
import { Button, Input, NativeSelect, Textarea } from "@ardurbot/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import type { FormEvent } from "react";
import { useId, useState } from "react";

export function ItemForm({
  items,
  bots,
  item,
  save,
}: {
  items: WorkItem[];
  bots: Pick<Bot, "id" | "name">[];
  item?: WorkItem;
  save: (
    input: BoardPatch & { title: string; dependencies?: BoardCreate["dependencies"] },
  ) => Promise<void>;
}) {
  const { t } = useLingui();
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? "").trim();
    const date = (key: "dueAt" | "deferUntil") => {
      const day = value(key);
      if (!day) return item ? null : undefined;
      const previous = item?.[key];
      return previous?.slice(0, 10) === day ? previous : new Date(day).toISOString();
    };
    setBusy(true);
    setError("");
    try {
      await save({
        title: value("title"),
        description: value("description"),
        acceptanceCriteria: value("acceptanceCriteria"),
        type: value("type") as BoardCreate["type"],
        priority: Number(value("priority")),
        labels: value("labels")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        assignee: value("assignee"),
        parent: value("parent") || (item ? null : undefined),
        dependencies: form.getAll("dependencies").map((id) => ({ id: String(id), type: "blocks" })),
        dueAt: date("dueAt"),
        deferUntil: date("deferUntil"),
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : t`Could not update this item.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <label htmlFor={`${formId}-title`} className="block space-y-1">
        <span>
          <Trans>Title</Trans>
        </span>
        <Input
          id={`${formId}-title`}
          name="title"
          required
          maxLength={500}
          defaultValue={item?.title}
        />
      </label>
      <div className="flex gap-4">
        <label htmlFor={`${formId}-type`} className="space-y-1">
          <span>
            <Trans>Type</Trans>
          </span>
          <NativeSelect id={`${formId}-type`} name="type" defaultValue={item?.type ?? "task"}>
            {BOARD_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label htmlFor={`${formId}-priority`} className="space-y-1">
          <span>
            <Trans>Priority</Trans>
          </span>
          <NativeSelect
            id={`${formId}-priority`}
            name="priority"
            defaultValue={item?.priority ?? 2}
          >
            {[0, 1, 2, 3, 4].map((priority) => (
              <option key={priority} value={priority}>
                P{priority}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      <label htmlFor={`${formId}-description`} className="block space-y-1">
        <span>
          <Trans>Description</Trans>
        </span>
        <Textarea
          id={`${formId}-description`}
          name="description"
          defaultValue={item?.description}
        />
      </label>
      <label htmlFor={`${formId}-acceptanceCriteria`} className="block space-y-1">
        <span>
          <Trans>Acceptance criteria</Trans>
        </span>
        <Textarea
          id={`${formId}-acceptanceCriteria`}
          name="acceptanceCriteria"
          defaultValue={item?.acceptanceCriteria}
        />
      </label>
      <details>
        <summary className="cursor-pointer text-muted-foreground">
          <Trans>More</Trans>
        </summary>
        <div className="mt-4 space-y-4">
          <label htmlFor={`${formId}-parent`} className="block space-y-1">
            <span>
              <Trans>Parent</Trans>
            </span>
            <NativeSelect id={`${formId}-parent`} name="parent" defaultValue={item?.parent ?? ""}>
              <option value="">—</option>
              {items
                .filter((other) => other.id !== item?.id)
                .map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.title}
                  </option>
                ))}
            </NativeSelect>
          </label>
          {!item ? (
            <label htmlFor={`${formId}-dependencies`} className="block space-y-1">
              <span>
                <Trans>Blocked by</Trans>
              </span>
              <select
                id={`${formId}-dependencies`}
                name="dependencies"
                multiple
                className="w-full rounded-lg border border-input bg-background p-2"
              >
                {items.map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label htmlFor={`${formId}-labels`} className="block space-y-1">
            <span>
              <Trans>Labels</Trans>
            </span>
            <Input id={`${formId}-labels`} name="labels" defaultValue={item?.labels.join(", ")} />
          </label>
          <label htmlFor={`${formId}-assignee`} className="block space-y-1">
            <span>
              <Trans>Assignee</Trans>
            </span>
            <Input
              id={`${formId}-assignee`}
              name="assignee"
              list={`${formId}-assignees`}
              defaultValue={item?.assignee ?? ""}
            />
            <datalist id={`${formId}-assignees`}>
              {bots.map((bot) => (
                <option key={bot.id} value={`bot:${bot.name}`} />
              ))}
            </datalist>
          </label>
          <label htmlFor={`${formId}-dueAt`} className="block space-y-1">
            <span>
              <Trans>Due</Trans>
            </span>
            <Input
              id={`${formId}-dueAt`}
              name="dueAt"
              type="date"
              defaultValue={item?.dueAt?.slice(0, 10)}
            />
          </label>
          <label htmlFor={`${formId}-deferUntil`} className="block space-y-1">
            <span>
              <Trans>Defer until</Trans>
            </span>
            <Input
              id={`${formId}-deferUntil`}
              name="deferUntil"
              type="date"
              defaultValue={item?.deferUntil?.slice(0, 10)}
            />
          </label>
        </div>
      </details>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {item ? <Trans>Save</Trans> : <Trans>New item</Trans>}
      </Button>
    </form>
  );
}
