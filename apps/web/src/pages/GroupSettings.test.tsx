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
