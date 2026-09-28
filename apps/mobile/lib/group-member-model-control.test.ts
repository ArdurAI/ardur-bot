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

it("persists runtime-only switches before screen Save and after reload in both directions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let saved: GroupMember = {
    ...member,
    runtimePin: {
      runtimeKind: "pi",
      provider: "openai-compatible",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
      revision: 2,
    },
  };
  vi.mocked(rpc).mockImplementation(async (route, input) => {
    if (route === "groups/setMemberModelPin") {
      const update = input as {
        expectedRevision: number;
        pin: NonNullable<GroupMember["runtimePin"]>;
      };
      expect(update.expectedRevision).toBe(saved.modelPinRevision);
      saved = {
        ...saved,
        modelPinRevision: update.expectedRevision + 1,
        runtimePin: { ...update.pin, revision: update.expectedRevision + 1 },
      };
    }
    return route === "groups/list"
      ? [{ id: "room", members: [saved] }]
      : { id: "room", members: [saved] };
  });
  const node = document.createElement("div");
  const root = createRoot(node);
  const props = {
    groupId: "room",
    experimental: true,
    catalog: [
      {
        provider: "openai-compatible",
        id: "valid",
        label: "Valid",
        reasoning: true,
        thinkingLevels: ["high"],
      },
    ],
    credentials: [
      {
        id: "connection",
        provider: "openai-compatible",
        label: "Connection",
        thinkingLevel: "high",
      },
    ],
    onSaved: vi.fn(),
    onError: vi.fn(),
  };
  async function reload() {
    const groups = (await rpc("groups/list")) as Array<{ members: GroupMember[] }>;
    await act(async () =>
      root.render(
        createElement(GroupMemberModelControl, {
          ...props,
          member: groups[0]!.members[0]!,
        } as never),
      ),
    );
  }
  await reload();
  for (const next of ["Hermes", "Ardur (built-in)"] as const) {
    await act(async () =>
      (node.querySelector('button[aria-label="Runtime · Worker"]') as HTMLButtonElement).click(),
    );
    await act(async () =>
      vi
        .mocked(presentMessageActionSheet)
        .mock.calls.at(-1)![0]
        .actions.find((action) => action.text === next)!
        .onPress(),
    );
    await rpc("groups/update", { groupId: "room" });
    await reload();
    expect(saved.runtimePin?.runtimeKind).toBe(next === "Hermes" ? "hermes" : "pi");
    expect(node.textContent).toContain(next);
  }
  expect(
    vi.mocked(rpc).mock.calls.filter(([route]) => route === "groups/setMemberModelPin"),
  ).toHaveLength(2);
  await act(async () => root.unmount());
});

it.each([
  { kind: "claude-code", label: "Claude Code (your claude sign-in)", provider: "anthropic" },
  { kind: "codex-app-server", label: "Codex (your ChatGPT sign-in)", provider: "openai-codex" },
  { kind: "antigravity", label: "Antigravity", provider: "antigravity" },
] as const)(
  "recovers a $kind native override through an ordinary connection with Experimental off",
  async ({ kind, label, provider }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const nativeMember: GroupMember = {
      ...member,
      runtimePin: {
        runtimeKind: kind,
        provider,
        modelId: "native-model",
        credentialId: `native:${kind}`,
        effort: kind === "antigravity" ? null : "high",
        revision: 2,
      },
    };
    const updated = {
      ...member,
      modelPinRevision: 3,
      runtimePin: {
        runtimeKind: "pi" as const,
        provider: "openai-compatible",
        modelId: "ordinary-model",
        credentialId: "connection",
        effort: "high",
        revision: 3,
      },
    };
    vi.mocked(rpc).mockResolvedValueOnce({ id: "room", members: [updated] });
    const node = document.createElement("div");
    const root = createRoot(node);
    await act(async () =>
      root.render(
        createElement(GroupMemberModelControl, {
          groupId: "room",
          member: nativeMember,
          experimental: false,
          catalog: [
            {
              provider: "openai-compatible",
              id: "ordinary-model",
              label: "Ordinary",
              reasoning: true,
              thinkingLevels: ["high"],
            },
          ],
          credentials: [
            {
              id: "connection",
              provider: "openai-compatible",
              label: "Connection",
              thinkingLevel: "high",
            },
          ],
          onSaved: vi.fn(),
          onError: vi.fn(),
        } as never),
      ),
    );
    expect(node.querySelector('button[aria-label="Runtime · Worker"]')).not.toBeNull();
    expect(node.textContent).toContain(label);
    await act(async () =>
      (
        node.querySelector('button[aria-label="Model in this group · Worker"]') as HTMLButtonElement
      ).click(),
    );
    const sheet = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0];
    await act(async () =>
      sheet.actions.find((action) => action.text === "openai-compatible · Ordinary")!.onPress(),
    );
    expect(rpc).toHaveBeenCalledWith(
      "groups/setMemberModelPin",
      expect.objectContaining({
        pin: expect.objectContaining({
          runtimeKind: "pi",
          provider: "openai-compatible",
          credentialId: "connection",
        }),
      }),
    );
    expect(node.querySelector('button[aria-label="Runtime · Worker"]')).toBeNull();
    expect(node.textContent).toContain("openai-compatible · Ordinary");
    await act(async () => root.unmount());
  },
);

it("chooses a compatible Hermes group connection, reads it back, and keeps it on Pi", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const saved = {
    ...member,
    modelPinRevision: 3,
    runtimePin: {
      runtimeKind: "hermes" as const,
      provider: "openai-compatible",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
      revision: 3,
    },
  };
  vi.mocked(rpc).mockResolvedValueOnce({ id: "room", members: [saved] });
  const node = document.createElement("div");
  const root = createRoot(node);
  const props = {
    groupId: "room",
    member,
    experimental: true,
    catalog: [
      {
        provider: "openai-compatible",
        id: "valid",
        label: "Valid",
        reasoning: true,
        thinkingLevels: ["high"],
      },
    ],
    credentials: [
      {
        id: "connection",
        provider: "openai-compatible",
        label: "Connection",
        thinkingLevel: "high",
      },
    ],
    onSaved: vi.fn(),
    onError: vi.fn(),
  };
  await act(async () => root.render(createElement(GroupMemberModelControl, props as never)));
  await act(async () =>
    (node.querySelector('button[aria-label="Runtime · Worker"]') as HTMLButtonElement).click(),
  );
  await act(async () =>
    vi
      .mocked(presentMessageActionSheet)
      .mock.calls.at(-1)![0]
      .actions.find((action) => action.text === "Hermes")!
      .onPress(),
  );
  await act(async () =>
    (
      node.querySelector('button[aria-label="Model in this group · Worker"]') as HTMLButtonElement
    ).click(),
  );
  const sheet = vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0];
  await act(async () => sheet.actions[1]!.onPress());
  expect(rpc).toHaveBeenCalledWith(
    "groups/setMemberModelPin",
    expect.objectContaining({
      pin: expect.objectContaining({ runtimeKind: "hermes", credentialId: "connection" }),
    }),
  );
  expect(node.textContent).toContain("openai-compatible · Valid");
  await act(async () =>
    (node.querySelector('button[aria-label="Runtime · Worker"]') as HTMLButtonElement).click(),
  );
  await act(async () =>
    vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0].actions[0]!.onPress(),
  );
  await act(async () =>
    (
      node.querySelector('button[aria-label="Model in this group · Worker"]') as HTMLButtonElement
    ).click(),
  );
  expect(vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0].actions[1]?.text).toBe(
    "openai-compatible · Valid",
  );
  await act(async () => root.unmount());
});

it("explains an incompatible saved connection and omits it from Hermes choices", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      createElement(GroupMemberModelControl, {
        groupId: "room",
        member: {
          ...member,
          runtimePin: {
            runtimeKind: "pi",
            provider: "anthropic",
            modelId: "valid",
            credentialId: "connection",
            effort: "high",
            revision: 2,
          },
        },
        experimental: true,
        catalog: [{ provider: "anthropic", id: "valid", label: "Valid" }],
        credentials: [{ id: "connection", provider: "anthropic", label: "Connection" }],
        onSaved: vi.fn(),
        onError: vi.fn(),
      } as never),
    ),
  );
  await act(async () =>
    (node.querySelector('button[aria-label="Runtime · Worker"]') as HTMLButtonElement).click(),
  );
  await act(async () =>
    vi
      .mocked(presentMessageActionSheet)
      .mock.calls.at(-1)![0]
      .actions.find((action) => action.text === "Hermes")!
      .onPress(),
  );
  expect(node.textContent).toContain("Hermes does not yet support Anthropic connections.");
  await act(async () =>
    (
      node.querySelector('button[aria-label="Model in this group · Worker"]') as HTMLButtonElement
    ).click(),
  );
  expect(vi.mocked(presentMessageActionSheet).mock.calls.at(-1)![0].actions).toHaveLength(1);
  expect(rpc).not.toHaveBeenCalled();
  await act(async () => root.unmount());
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
  expect(
    node
      .querySelector('button[aria-label="Model in this group · Worker"]')
      ?.getAttribute("aria-label"),
  ).toBe("Model in this group · Worker");
  await act(async () =>
    (
      node.querySelector('button[aria-label="Model in this group · Worker"]') as HTMLButtonElement
    ).click(),
  );
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
  await act(async () =>
    (
      node.querySelector('button[aria-label="Model in this group · Worker"]') as HTMLButtonElement
    ).click(),
  );
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
  await act(async () =>
    (
      node.querySelector('button[aria-label="Model in this group · Worker"]') as HTMLButtonElement
    ).click(),
  );
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
  await act(async () =>
    (node.querySelector('button[aria-label="Thinking · Worker"]') as HTMLButtonElement).click(),
  );
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
  await act(async () =>
    (
      node.querySelector('button[aria-label="Model in this group · Worker"]') as HTMLButtonElement
    ).click(),
  );
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
  await act(async () =>
    (
      node.querySelector('button[aria-label="Model in this group · Worker"]') as HTMLButtonElement
    ).click(),
  );
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

it("displays an inherited Hermes runtime initially and persists a runtime-only switch for an inherited member", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const inheritedHermesMember: GroupMember = {
    ...member,
    runtimePin: null,
    effectiveRuntimePin: {
      runtimeKind: "hermes",
      provider: "openai-compatible",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
      revision: 2,
    },
  };
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      createElement(GroupMemberModelControl, {
        groupId: "room",
        member: inheritedHermesMember,
        botRuntimeKind: "hermes",
        experimental: true,
        catalog: [
          {
            provider: "openai-compatible",
            id: "valid",
            label: "Valid",
            reasoning: true,
            thinkingLevels: ["high"],
          },
        ],
        credentials: [
          {
            id: "connection",
            provider: "openai-compatible",
            label: "Connection",
            thinkingLevel: "high",
          },
        ],
        onSaved: vi.fn(),
        onError: vi.fn(),
      } as never),
    ),
  );
  expect(node.querySelector('button[aria-label="Runtime · Worker"]')?.textContent).toContain(
    "Hermes",
  );

  const inheritedPiMember: GroupMember = {
    ...member,
    runtimePin: null,
    effectiveRuntimePin: {
      runtimeKind: "pi",
      provider: "openai-compatible",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
      revision: 2,
    },
  };
  const savedGroup = {
    id: "room",
    members: [
      {
        ...member,
        modelPinRevision: 3,
        runtimePin: {
          runtimeKind: "hermes",
          provider: "openai-compatible",
          modelId: "valid",
          credentialId: "connection",
          effort: "high",
          revision: 3,
        },
      },
    ],
  };
  vi.mocked(rpc).mockResolvedValueOnce(savedGroup);
  await act(async () =>
    root.render(
      createElement(GroupMemberModelControl, {
        groupId: "room",
        member: inheritedPiMember,
        botRuntimeKind: "pi",
        experimental: true,
        catalog: [
          {
            provider: "openai-compatible",
            id: "valid",
            label: "Valid",
            reasoning: true,
            thinkingLevels: ["high"],
          },
        ],
        credentials: [
          {
            id: "connection",
            provider: "openai-compatible",
            label: "Connection",
            thinkingLevel: "high",
          },
        ],
        onSaved: vi.fn(),
        onError: vi.fn(),
      } as never),
    ),
  );
  expect(node.querySelector('button[aria-label="Runtime · Worker"]')?.textContent).toContain(
    "Ardur (built-in)",
  );
  await act(async () =>
    (node.querySelector('button[aria-label="Runtime · Worker"]') as HTMLButtonElement).click(),
  );
  await act(async () =>
    vi
      .mocked(presentMessageActionSheet)
      .mock.calls.at(-1)![0]
      .actions.find((action) => action.text === "Hermes")!
      .onPress(),
  );
  expect(rpc).toHaveBeenCalledWith("groups/setMemberModelPin", {
    groupId: "room",
    botId: "worker",
    memberId: "member",
    expectedRevision: 2,
    pin: {
      runtimeKind: "hermes",
      provider: "openai-compatible",
      modelId: "valid",
      credentialId: "connection",
      effort: "high",
    },
  });
  await act(async () => root.unmount());
});
