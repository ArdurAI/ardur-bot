// @vitest-environment jsdom
import type { Bot, Group } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  BotAvatar: () => null,
}));
vi.mock("./group-model-control", () => ({ GroupModelControl: () => null }));

import { GroupSettings } from "./GroupPanel";

const bots = ["a", "b", "c", "d"].map((id) => ({ id, name: id, color: "#111" })) as Bot[];
const group = (name: string, ids: string[], coordinatorBotId: string | null = null) =>
  ({
    id: "group",
    name,
    coordinatorBotId,
    members: ids.map((botId) => ({ botId, name: botId, color: "#111" })),
  }) as Group;
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const saveButton = () =>
  [...node.querySelectorAll("button")].find((button) => button.textContent === "Save")!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

it("adopts two refreshed groups before Save without removing a peer's new member or name", async () => {
  const onSave = vi.fn(async () => undefined);
  const render = (value: Group) =>
    root.render(
      <GroupSettings
        group={value}
        bots={bots}
        goal={null}
        canManageGoal={false}
        onStartGoal={vi.fn()}
        onSave={onSave}
        onModelPin={vi.fn()}
        modelSettings={null}
        onRemove={vi.fn()}
      />,
    );
  await act(async () => render(group("Original", ["a", "b"])));
  await act(async () => {
    flushSync(() => render(group("Renamed", ["a", "b", "c"])));
    flushSync(() => render(group("Newest", ["a", "b", "c", "d"], "c")));
  });
  expect(node.querySelector("input")?.value).toBe("Newest");
  const selectedMembers = [...node.querySelectorAll('button[aria-pressed="true"]')]
    .map((button) => button.textContent?.trim())
    .filter((name) => bots.some((bot) => bot.name === name));
  expect(selectedMembers).toEqual(["a", "b", "c", "d"]);
  await act(async () => saveButton().click());
  expect(onSave).toHaveBeenCalledWith({
    name: undefined,
    botIds: undefined,
    coordinatorBotId: "c",
  });
});

it("keeps an edited name while adopting an untouched refreshed member list", async () => {
  const onSave = vi.fn(async () => undefined);
  const render = (value: Group) =>
    root.render(
      <GroupSettings
        group={value}
        bots={bots}
        goal={null}
        canManageGoal={false}
        onStartGoal={vi.fn()}
        onSave={onSave}
        onModelPin={vi.fn()}
        modelSettings={null}
        onRemove={vi.fn()}
      />,
    );
  await act(async () => render(group("Original", ["a", "b"])));
  const input = node.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "My edit",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => render(group("Renamed", ["a", "b", "c"])));
  expect(input.value).toBe("My edit");
  await act(async () => saveButton().click());
  expect(onSave).toHaveBeenCalledWith({
    name: "My edit",
    botIds: undefined,
    coordinatorBotId: null,
  });
});

it("warns only while the picked coordinator's runtime can't use Ardur tools", async () => {
  const runtimeBots = [
    { id: "a", name: "a", color: "#111", runtimeKind: "antigravity" },
    { id: "b", name: "b", color: "#111", runtimeKind: "codex-app-server" },
  ] as Bot[];
  const render = (value: Group) =>
    root.render(
      <GroupSettings
        group={value}
        bots={runtimeBots}
        goal={null}
        canManageGoal={false}
        onStartGoal={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onModelPin={vi.fn()}
        modelSettings={null}
        onRemove={vi.fn()}
      />,
    );
  await act(async () => render(group("Team", ["a", "b"], "a")));
  const warning = () => node.querySelector('[data-testid="coordinator-tools-warning"]');
  expect(warning()?.textContent).toContain("Antigravity");
  const select = node.querySelector("select")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "b");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(warning()).toBeNull();
});

it("clears the tools warning when the coordinator leaves the member selection", async () => {
  const onSave = vi.fn(async () => undefined);
  const runtimeBots = [
    { id: "a", name: "a", color: "#111", runtimeKind: "antigravity" },
    { id: "b", name: "b", color: "#111", runtimeKind: "codex-app-server" },
    { id: "c", name: "c", color: "#111", runtimeKind: "codex-app-server" },
  ] as Bot[];
  await act(async () =>
    root.render(
      <GroupSettings
        group={group("Team", ["a", "b", "c"], "a")}
        bots={runtimeBots}
        goal={null}
        canManageGoal={false}
        onStartGoal={vi.fn()}
        onSave={onSave}
        onModelPin={vi.fn()}
        modelSettings={null}
        onRemove={vi.fn()}
      />,
    ),
  );
  const warning = () => node.querySelector('[data-testid="coordinator-tools-warning"]');
  expect(warning()?.textContent).toContain("Antigravity");
  const select = node.querySelector("select")!;
  expect(select.value).toBe("a");

  // Uncheck the coordinator in the member list: the dropdown falls back to None.
  const memberA = [...node.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')].find(
    (button) => button.textContent?.trim() === "a",
  )!;
  await act(async () => memberA.click());
  expect(select.value).toBe("");
  expect(warning()).toBeNull();

  await act(async () => saveButton().click());
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ coordinatorBotId: null, botIds: ["b", "c"] }),
  );
});

it("judges the coordinator by the member's effective pin, not the bot default", async () => {
  const runtimeBots = [
    { id: "a", name: "a", color: "#111", runtimeKind: "antigravity" },
    { id: "b", name: "b", color: "#111", runtimeKind: "pi" },
  ] as Bot[];
  const pinned = group("Team", ["a", "b"], "a");
  pinned.members[0]!.effectiveRuntimePin = { runtimeKind: "codex-app-server" } as never;
  await act(async () =>
    root.render(
      <GroupSettings
        group={pinned}
        bots={runtimeBots}
        goal={null}
        canManageGoal={false}
        onStartGoal={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onModelPin={vi.fn()}
        modelSettings={null}
        onRemove={vi.fn()}
      />,
    ),
  );
  expect(node.querySelector('[data-testid="coordinator-tools-warning"]')).toBeNull();
});
