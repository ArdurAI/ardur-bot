// @vitest-environment jsdom
import type { GroupMember } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { GroupMemberModelControl } from "../components/group-member-model-control";
import { rpc } from "./api";
import { presentMessageActionSheet } from "./message-action-sheet";
import { RpcError } from "./rpc-error";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
const translations: Record<string, string> = {};
vi.mock("./i18n", () => ({
  useI18n: () => ({ t: (text: string) => translations[text] ?? text }),
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}), useResolvedAppearance: () => "light" }));
vi.mock("react-native", () => ({
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
    disabled?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, disabled, "aria-label": accessibilityLabel },
      children,
    ),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));

const member: GroupMember = {
  botId: "worker",
  memberId: "member",
  modelPinRevision: 2,
  runtimePin: null,
  name: "Worker",
  color: "#111",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rpc).mockReset();
  for (const key of Object.keys(translations)) delete translations[key];
});

it("uses the native model sheet to save and clear the selected member pin", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const updated = {
    ...member,
    modelPinRevision: 3,
    runtimePin: {
      runtimeKind: "pi" as const,
      provider: "fixture",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
      revision: 3,
    },
  };
  vi.mocked(rpc)
    .mockResolvedValueOnce({ id: "room", members: [updated] })
    .mockResolvedValueOnce({ id: "room", members: [member] });
  const node = document.createElement("div");
  const root = createRoot(node);
  const onSaved = vi.fn();
  const onError = vi.fn();
  await act(async () =>
    root.render(
      createElement(GroupMemberModelControl, {
        groupId: "room",
        member,
        catalog: [
          {
            provider: "fixture",
            providerName: "Fixture",
            id: "valid",
            label: "Valid",
            reasoning: true,
            thinkingLevels: ["low", "high"],
          },
        ],
        credentials: [
          { id: "connection", provider: "fixture", label: "Connection", thinkingLevel: "high" },
        ],
        onSaved,
        onError,
      } as never),
    ),
  );
  expect(node.querySelector("button")?.getAttribute("aria-label")).toBe(
    "Model in this group · Worker",
  );
  await act(async () => node.querySelector("button")!.click());
  const sheet = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0];
  expect(sheet.actions.map((action) => action.text)).toEqual(["Same as bot", "Fixture · Valid"]);
  await act(async () => sheet.actions[1]!.onPress());
  expect(rpc).toHaveBeenCalledWith("groups/setMemberModelPin", {
    groupId: "room",
    botId: "worker",
    memberId: "member",
    expectedRevision: 2,
    pin: {
      runtimeKind: "pi",
      provider: "fixture",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
    },
  });
  expect(onSaved).toHaveBeenCalledOnce();
  await act(async () =>
    root.render(
      createElement(GroupMemberModelControl, {
        groupId: "room",
        member: updated,
        catalog: [
          {
            provider: "fixture",
            providerName: "Fixture",
            id: "valid",
            label: "Valid",
            reasoning: true,
            thinkingLevels: ["low", "high"],
          },
        ],
        credentials: [
          { id: "connection", provider: "fixture", label: "Connection", thinkingLevel: "high" },
        ],
        onSaved,
        onError,
      } as never),
    ),
  );
  expect(node.textContent).toContain("Fixture · Valid");
  await act(async () => node.querySelector("button")!.click());
  const resetSheet = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0];
  await act(async () => resetSheet.actions[0]!.onPress());
  expect(rpc).toHaveBeenLastCalledWith("groups/clearMemberModelPin", {
    groupId: "room",
    botId: "worker",
    memberId: "member",
    expectedRevision: 3,
  });
  await act(async () => root.unmount());
});

it("preserves saved effort when reselecting the member's current model", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pinnedMember: GroupMember = {
    ...member,
    modelPinRevision: 3,
    runtimePin: {
      runtimeKind: "pi" as const,
      provider: "fixture",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
      revision: 3,
    },
  };
  vi.mocked(rpc).mockResolvedValueOnce({ id: "room", members: [pinnedMember] });
  const node = document.createElement("div");
  const root = createRoot(node);
  const onSaved = vi.fn();
  const onError = vi.fn();
  await act(async () =>
    root.render(
      createElement(GroupMemberModelControl, {
        groupId: "room",
        member: pinnedMember,
        catalog: [
          {
            provider: "fixture",
            providerName: "Fixture",
            id: "valid",
            label: "Valid",
            reasoning: true,
            thinkingLevels: ["medium", "high"],
          },
        ],
        credentials: [{ id: "connection", provider: "fixture", label: "Connection" }],
        onSaved,
        onError,
      } as never),
    ),
  );
  await act(async () => node.querySelector("button")!.click());
  const sheet = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0];
  await act(async () => sheet.actions[1]!.onPress());
  expect(rpc).toHaveBeenCalledWith("groups/setMemberModelPin", {
    groupId: "room",
    botId: "worker",
    memberId: "member",
    expectedRevision: 3,
    pin: {
      runtimeKind: "pi",
      provider: "fixture",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
    },
  });
  expect(onSaved).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

it("changes effort on the same saved model and connection", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pinnedMember: GroupMember = {
    ...member,
    runtimePin: {
      runtimeKind: "pi",
      provider: "fixture",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
      revision: 2,
    },
  };
  vi.mocked(rpc).mockResolvedValueOnce({
    id: "room",
    members: [
      {
        ...pinnedMember,
        modelPinRevision: 3,
        runtimePin: { ...pinnedMember.runtimePin, effort: "low" },
      },
    ],
  });
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      createElement(GroupMemberModelControl, {
        groupId: "room",
        member: pinnedMember,
        catalog: [
          {
            provider: "fixture",
            providerName: "Fixture",
            id: "valid",
            label: "Valid",
            reasoning: true,
            thinkingLevels: ["low", "high"],
          },
        ],
        credentials: [{ id: "connection", provider: "fixture", label: "Connection" }],
        onSaved: vi.fn(),
        onError: vi.fn(),
      } as never),
    ),
  );
  expect(node.textContent).toContain("High");
  await act(async () => node.querySelectorAll("button")[1]!.click());
  const sheet = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0];
  await act(async () => sheet.actions.find((action) => action.text === "Low")!.onPress());
  expect(rpc).toHaveBeenCalledWith("groups/setMemberModelPin", {
    groupId: "room",
    botId: "worker",
    memberId: "member",
    expectedRevision: 2,
    pin: {
      runtimeKind: "pi",
      provider: "fixture",
      modelId: "valid",
      credentialId: "connection",
      effort: "low",
    },
  });
  await act(async () => root.unmount());
});

it("reloads the group on conflict and sends the refreshed revision on the next save", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const reloadedMember: GroupMember = {
    ...member,
    modelPinRevision: 5,
  };
  const reloadedGroup = { id: "room", members: [reloadedMember] };
  const savedGroup = {
    id: "room",
    members: [{ ...reloadedMember, modelPinRevision: 6 }],
  };
  vi.mocked(rpc)
    .mockRejectedValueOnce(
      new RpcError("This member's model changed. Reload the group.", "CONFLICT"),
    )
    .mockResolvedValueOnce([reloadedGroup])
    .mockResolvedValueOnce(savedGroup);

  const node = document.createElement("div");
  const root = createRoot(node);
  const onSaved = vi.fn();
  const onError = vi.fn();
  await act(async () =>
    root.render(
      createElement(GroupMemberModelControl, {
        groupId: "room",
        member,
        catalog: [
          {
            provider: "fixture",
            providerName: "Fixture",
            id: "valid",
            label: "Valid",
            reasoning: true,
            thinkingLevels: ["low", "high"],
          },
        ],
        credentials: [
          { id: "connection", provider: "fixture", label: "Connection", thinkingLevel: "high" },
        ],
        onSaved,
        onError,
      } as never),
    ),
  );

  // First save attempts with stale expectedRevision: 2, but API returns CONFLICT
  await act(async () => node.querySelector("button")!.click());
  const sheet = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0];
  await act(async () => sheet.actions[1]!.onPress());

  expect(rpc).toHaveBeenNthCalledWith(1, "groups/setMemberModelPin", {
    groupId: "room",
    botId: "worker",
    memberId: "member",
    expectedRevision: 2,
    pin: {
      runtimeKind: "pi",
      provider: "fixture",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
    },
  });
  expect(rpc).toHaveBeenNthCalledWith(2, "groups/list");
  expect(onError).toHaveBeenCalledWith("This member's model changed. Reload the group.");
  expect(onSaved).toHaveBeenCalledWith(reloadedGroup);

  // Next save sends the reloaded revision 5
  await act(async () => node.querySelector("button")!.click());
  const nextSheet = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0];
  await act(async () => nextSheet.actions[1]!.onPress());

  expect(rpc).toHaveBeenNthCalledWith(3, "groups/setMemberModelPin", {
    groupId: "room",
    botId: "worker",
    memberId: "member",
    expectedRevision: 5,
    pin: {
      runtimeKind: "pi",
      provider: "fixture",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
    },
  });
  expect(onSaved).toHaveBeenLastCalledWith(savedGroup);
  await act(async () => root.unmount());
});

it("translates an off effort in the thinking row", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  translations.Off = "Выключено";
  const pinnedOff = {
    ...member,
    runtimePin: {
      runtimeKind: "pi" as const,
      provider: "fixture",
      modelId: "valid",
      credentialId: "connection",
      effort: "off",
      revision: 2,
    },
  };
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      createElement(GroupMemberModelControl, {
        groupId: "room",
        member: pinnedOff,
        catalog: [
          {
            provider: "fixture",
            providerName: "Fixture",
            id: "valid",
            label: "Valid",
            reasoning: true,
            thinkingLevels: ["off", "low", "high"],
          },
        ],
        credentials: [{ id: "connection", provider: "fixture", label: "Connection" }],
        onSaved: vi.fn(),
        onError: vi.fn(),
      } as never),
    ),
  );
  expect(node.textContent).toContain("Выключено");
  expect(node.textContent).not.toContain("Off");
  await act(async () => root.unmount());
});
