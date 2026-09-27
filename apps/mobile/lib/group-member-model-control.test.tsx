// @vitest-environment jsdom
import type { GroupMember } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { GroupMemberModelControl } from "../components/group-member-model-control";
import { rpc } from "./api";
import { presentMessageActionSheet } from "./message-action-sheet";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
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

beforeEach(() => vi.clearAllMocks());

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
