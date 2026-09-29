// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import type { MobileBot, MobileGroup } from "./api";
import { rpc } from "./api";
import { presentMessageActionSheet } from "./message-action-sheet";

let lastOnSaved: ((refreshed: MobileGroup) => void) | undefined;
let lastSelectedMembers: string[] = [];

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string | number>) =>
      values
        ? text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
            Object.hasOwn(values, key) ? String(values[key]) : match,
          )
        : text,
  }),
}));
vi.mock("./native", () => ({
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("./dispatch", () => ({ hasPairedDevice: vi.fn(async () => false) }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ back: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => ({ groupId: "group-1" }),
}));
vi.mock("../components/context-section", () => ({ ContextSection: () => null }));
vi.mock("../components/bot-member-picker", () => ({
  BotMemberPicker: (props: { selected: string[]; onChange: (botIds: string[]) => void }) => {
    lastSelectedMembers = props.selected;
    return createElement("div", { "data-testid": "member-picker" }, props.selected.join(","));
  },
}));
vi.mock("../components/group-member-model-control", () => ({
  GroupMemberModelControl: (props: {
    groupId: string;
    member: { botId: string };
    onSaved: (group: MobileGroup) => void;
  }) => {
    lastOnSaved = props.onSaved;
    return createElement("div", { "data-testid": `member-${props.member.botId}` });
  },
}));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    StyleSheet: { create: (styles: unknown) => styles },
    Alert: { alert: vi.fn() },
    ScrollView: box,
    View: box,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    TextInput: ({
      value,
      onChangeText,
      placeholder,
    }: {
      value?: string;
      onChangeText?: (text: string) => void;
      placeholder?: string;
    }) =>
      createElement("input", {
        value,
        placeholder,
        onInput: (e: { currentTarget: HTMLInputElement }) => onChangeText?.(e.currentTarget.value),
        onChange: () => undefined,
      }),
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => createElement("button", { type: "button", onClick: onPress, disabled }, children),
  };
});

import GroupSettingsScreen from "../app/group-settings";

const initialGroup = {
  id: "group-1",
  name: "Original Group",
  coordinatorBotId: null,
  members: [
    { botId: "bot-a", memberId: "m-a", name: "Bot A", color: "#111" },
    { botId: "bot-b", memberId: "m-b", name: "Bot B", color: "#222" },
  ],
} as unknown as MobileGroup;

const refreshedGroup = {
  id: "group-1",
  name: "Renamed by Peer",
  coordinatorBotId: null,
  members: [
    { botId: "bot-a", memberId: "m-a", name: "Bot A", color: "#111" },
    { botId: "bot-b", memberId: "m-b", name: "Bot B", color: "#222" },
    { botId: "bot-c", memberId: "m-c", name: "Bot C", color: "#333" },
  ],
} as unknown as MobileGroup;

const refreshedAgainGroup = {
  ...refreshedGroup,
  members: [
    ...refreshedGroup.members,
    { botId: "bot-d", memberId: "m-d", name: "Bot D", color: "#444" },
  ],
} as unknown as MobileGroup;

const bots = [
  { id: "bot-a", name: "Bot A", color: "#111" },
  { id: "bot-b", name: "Bot B", color: "#222" },
  { id: "bot-c", name: "Bot C", color: "#333" },
  { id: "bot-d", name: "Bot D", color: "#444" },
] as unknown as MobileBot[];

beforeEach(() => {
  vi.clearAllMocks();
  lastOnSaved = undefined;
  lastSelectedMembers = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc).mockImplementation(async (route) => {
    if (route === "groups/list") return [initialGroup];
    if (route === "bots/list") return bots;
    if (route === "models/list") return [];
    if (route === "models/credentials") return [];
    if (route === "groups/update") return refreshedGroup;
    return null;
  });
});

it("adopts refreshed name and concurrent member C when untouched, without sending stale removals on save", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(GroupSettingsScreen)));

  expect(node.querySelector("input")?.value).toBe("Original Group");
  expect(lastSelectedMembers).toEqual(["bot-a", "bot-b"]);
  expect(lastOnSaved).toBeDefined();

  // Peer added member C and renamed group; model save/conflict triggers onSaved
  await act(async () => lastOnSaved!(refreshedGroup));

  // Untouched form drafts must adopt the refreshed group's values
  expect(node.querySelector("input")?.value).toBe("Renamed by Peer");
  expect(lastSelectedMembers).toEqual(["bot-a", "bot-b", "bot-c"]);

  // Press Save
  const saveButton = [...node.querySelectorAll("button")].find((b) => b.textContent === "Save");
  expect(saveButton).toBeDefined();
  await act(async () => saveButton!.click());

  // Must not send stale drafts: cannot omit C as a removal ([bot-a, bot-b]) or overwrite name with Original Group
  expect(rpc).not.toHaveBeenCalledWith(
    "groups/update",
    expect.objectContaining({ botIds: ["bot-a", "bot-b"] }),
  );
  expect(rpc).not.toHaveBeenCalledWith(
    "groups/update",
    expect.objectContaining({ name: "Original Group" }),
  );

  await act(async () => root.unmount());
});

it("preserves deliberate name edit across refresh while still adopting concurrent member C", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(GroupSettingsScreen)));

  const nameInput = node.querySelector("input")!;
  expect(nameInput.value).toBe("Original Group");

  // User deliberately edits name before the refresh
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      nameInput,
      "User Edited Name",
    );
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Peer added member C and renamed group; onSaved arrives
  await act(async () => lastOnSaved!(refreshedGroup));

  // Deliberate name edit must be preserved, while untouched members adopt C
  expect(node.querySelector("input")?.value).toBe("User Edited Name");
  expect(lastSelectedMembers).toEqual(["bot-a", "bot-b", "bot-c"]);

  // Press Save
  const saveButton = [...node.querySelectorAll("button")].find((b) => b.textContent === "Save");
  await act(async () => saveButton!.click());

  // Save must send the deliberate name edit and must not drop member C
  expect(rpc).toHaveBeenCalledWith(
    "groups/update",
    expect.objectContaining({ name: "User Edited Name" }),
  );
  expect(rpc).not.toHaveBeenCalledWith(
    "groups/update",
    expect.objectContaining({ botIds: ["bot-a", "bot-b"] }),
  );

  await act(async () => root.unmount());
});

it("keeps edits typed while a member-model save was in flight", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(GroupSettingsScreen)));

  // The control captured this callback when the save started.
  const inFlightOnSaved = lastOnSaved!;
  expect(inFlightOnSaved).toBeDefined();

  // The user keeps typing before the response arrives.
  const nameInput = node.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      nameInput,
      "Typed During Save",
    );
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // The response resolves through the callback captured before the edit.
  await act(async () => inFlightOnSaved(refreshedGroup));

  // The typed name survives; the untouched member list still adopts C.
  expect(node.querySelector("input")?.value).toBe("Typed During Save");
  expect(lastSelectedMembers).toEqual(["bot-a", "bot-b", "bot-c"]);

  await act(async () => root.unmount());
});

it("adopts two refreshes delivered before a render without dropping the newest member", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(GroupSettingsScreen)));
  const onSaved = lastOnSaved!;

  // Two member-model saves finish in the same tick, each with a newer peer addition.
  await act(async () => {
    onSaved(refreshedGroup);
    onSaved(refreshedAgainGroup);
  });

  expect(lastSelectedMembers).toEqual(["bot-a", "bot-b", "bot-c", "bot-d"]);
  expect(node.querySelector("input")?.value).toBe("Renamed by Peer");

  const saveButton = [...node.querySelectorAll("button")].find((b) => b.textContent === "Save");
  await act(async () => saveButton!.click());
  // Untouched drafts equal the latest group, so Save must not send a member list at all.
  expect(rpc).not.toHaveBeenCalledWith(
    "groups/update",
    expect.objectContaining({ botIds: expect.anything() }),
  );

  await act(async () => root.unmount());
});

it("saves how many bots answer at once, defaulting to four", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(GroupSettingsScreen)));

  const row = () =>
    [...node.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Bots answering at once:"),
    )!;
  // A room without a stored policy reads the shared default.
  expect(row().textContent).toBe("Bots answering at once: 4");

  await act(async () => row().click());
  const sheet = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0] as unknown as {
    actions: { text: string; onPress: () => void }[];
  };
  expect(sheet.actions.map((action) => action.text)).toEqual([
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
  ]);
  await act(async () => sheet.actions.find((action) => action.text === "1")!.onPress());
  expect(row().textContent).toBe("Bots answering at once: 1");

  const saveButton = [...node.querySelectorAll("button")].find((b) => b.textContent === "Save");
  await act(async () => saveButton!.click());
  expect(rpc).toHaveBeenCalledWith(
    "groups/update",
    expect.objectContaining({ groupId: "group-1", roomPolicy: { maxConcurrentRuns: 1 } }),
  );

  await act(async () => root.unmount());
});

it("warns only while the picked coordinator's runtime can't use Ardur tools", async () => {
  const antigravityGroup = {
    ...initialGroup,
    coordinatorBotId: "bot-a",
  } as unknown as MobileGroup;
  const runtimeBots = [
    { id: "bot-a", name: "Bot A", color: "#111", runtimeKind: "antigravity" },
    { id: "bot-b", name: "Bot B", color: "#222", runtimeKind: "codex-app-server" },
  ] as unknown as MobileBot[];
  vi.mocked(rpc).mockImplementation(async (route) => {
    if (route === "groups/list") return [antigravityGroup];
    if (route === "bots/list") return runtimeBots;
    if (route === "models/list") return [];
    if (route === "models/credentials") return [];
    if (route === "groups/update") return antigravityGroup;
    return null;
  });
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(createElement(GroupSettingsScreen)));

  const warning = () =>
    [...node.querySelectorAll("span")].find((el) =>
      el.textContent?.includes("can't use Ardur tools"),
    );
  expect(warning()?.textContent).toContain(
    "Antigravity can't use Ardur tools — a coordinator needs tools to hand off work.",
  );

  const coordinatorButton = [...node.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Coordinator:"),
  )!;
  const sheet = () =>
    vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0] as unknown as {
      actions: { text: string; onPress: () => void }[];
    };

  // Choosing None clears the warning.
  await act(async () => coordinatorButton.click());
  await act(async () =>
    sheet()
      .actions.find((action) => action.text === "None")!
      .onPress(),
  );
  expect(warning()).toBeUndefined();

  // A tools-capable coordinator shows no warning either.
  await act(async () => coordinatorButton.click());
  await act(async () =>
    sheet()
      .actions.find((action) => action.text === "Bot B")!
      .onPress(),
  );
  expect(warning()).toBeUndefined();

  // Picking the Antigravity bot again brings the warning back.
  await act(async () => coordinatorButton.click());
  await act(async () =>
    sheet()
      .actions.find((action) => action.text === "Bot A")!
      .onPress(),
  );
  expect(warning()?.textContent).toContain("Antigravity");

  await act(async () => root.unmount());
});
