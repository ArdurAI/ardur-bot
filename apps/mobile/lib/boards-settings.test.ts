// @vitest-environment jsdom
import { SetLearningReviewerInput } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
const learningSettings = vi.hoisted(() => vi.fn());
const sheet = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc: request }));
vi.mock("./dispatch", () => ({ hasPairedDevice: async () => false }));
vi.mock("./learning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./learning")>();
  return { ...actual, loadLearningSettings: learningSettings };
});
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: sheet }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string | number>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? key)),
  }),
}));
vi.mock("./native", () => ({
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push }),
}));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    StyleSheet: { create: (styles: unknown) => styles },
    ActivityIndicator: () => createElement("span", { "data-loading": true }),
    Alert: { alert: vi.fn() },
    ScrollView: box,
    View: box,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    TextInput: () => createElement("input"),
    Switch: ({ accessibilityLabel, value }: { accessibilityLabel: string; value: boolean }) =>
      createElement("input", {
        type: "checkbox",
        "aria-label": accessibilityLabel,
        checked: value,
        readOnly: true,
      }),
    Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
      createElement("button", { type: "button", onClick: onPress }, title),
  };
});

import BoardsSettings from "../app/boards-settings";

const workspace = {
  id: "space-board",
  kind: "space",
  path: "/board",
  prefix: "board",
  name: "Board",
  enabled: true,
  initialized: true,
  isDefault: true,
  allowAllBots: true,
  allowedBotIds: [],
};
let upkeep: () => Promise<unknown>;
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  upkeep = async () => ({ enabled: false });
  request.mockImplementation(async (procedure: string) => {
    if (procedure === "me") return { isDeploymentOwner: true };
    if (procedure === "board/workspaces") return { workspaces: [workspace], problem: null };
    if (procedure === "bots/list") return [];
    if (procedure === "board/upkeep") return upkeep();
    if (procedure === "models/list") return [];
    if (procedure === "models/credentials") return [];
    if (procedure === "runtimes/availability") return { available: false, models: [] };
    throw new Error(`Unexpected ${procedure}`);
  });
  learningSettings.mockResolvedValue({
    enabled: true,
    canConfigure: true,
    destination: { modelId: "local-model" },
  });
  node = document.createElement("div");
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.render(createElement("div")));
  await act(async () => root.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const upkeepSwitch = () =>
  node.querySelector<HTMLInputElement>('[aria-label="Bots keep the board and memory current"]');

it.each(["upkeep", "learning"])(
  "shows a load failure with Retry instead of a default state when the %s read fails",
  async (failing) => {
    if (failing === "upkeep") upkeep = async () => Promise.reject(new Error("offline"));
    else learningSettings.mockRejectedValueOnce(new Error("offline"));
    await act(async () => root.render(createElement(BoardsSettings)));
    expect(node.textContent).toContain("Could not load Board; retry.");
    expect(upkeepSwitch()).toBeNull();
    expect(node.textContent).not.toContain("Learning review is");
    upkeep = async () => ({ enabled: false });
    await act(async () =>
      [...node.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry")!
        .click(),
    );
    expect(node.textContent).not.toContain("Could not load Board; retry.");
    expect(upkeepSwitch()?.checked).toBe(false);
    expect(node.textContent).toContain("Learning review");
    expect(node.textContent).not.toContain("Learning review is on");
    expect(node.textContent).not.toContain("Learning review is off");
    expect(node.textContent).toContain("Reviewer: local-model");
  },
);

it("opens the loaded reviewer choices and saves the selected connection", async () => {
  const saved = {
    enabled: true,
    canConfigure: true,
    reviewerPin: {
      runtimeKind: "pi",
      provider: "openai",
      modelId: "reviewer",
      credentialId: "cred",
      effort: "medium",
      revision: 1,
    },
    consolidationEnabled: false,
    budgets: {},
    destination: null,
  };
  learningSettings.mockResolvedValue({
    enabled: false,
    canConfigure: true,
    reviewerPin: null,
    consolidationEnabled: false,
    budgets: {},
    destination: {
      runtimeKind: "pi",
      provider: "openai",
      modelId: "starter",
      credentialId: "cred",
      effort: "medium",
      revision: 2,
    },
  });
  request.mockImplementation(async (procedure: string) => {
    if (procedure === "me") return { isDeploymentOwner: true };
    if (procedure === "board/workspaces") return { workspaces: [workspace], problem: null };
    if (procedure === "bots/list") return [];
    if (procedure === "board/upkeep") return { enabled: false };
    if (procedure === "models/list") {
      return [
        {
          provider: "openai",
          id: "reviewer",
          label: "Reviewer",
          billing: "usage",
          thinkingLevels: ["medium", "high"],
        },
      ];
    }
    if (procedure === "models/credentials") {
      return [{ id: "cred", provider: "openai", label: "OpenAI", hasKey: true, isDefault: true }];
    }
    if (procedure === "runtimes/availability") {
      return { available: false, models: [] };
    }
    if (procedure === "learning/setReviewer") {
      // The server persisted the choice, so the reload after the save shows it.
      learningSettings.mockResolvedValue(saved);
      return saved;
    }
    throw new Error(`Unexpected ${procedure}`);
  });
  await act(async () => root.render(createElement(BoardsSettings)));
  const reviewer = [...node.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Reviewer:"),
  );
  expect(reviewer?.textContent).toBe("Reviewer: starter");
  await act(async () => reviewer!.click());
  const opened = sheet.mock.calls.at(-1)?.[0] as {
    options?: unknown;
    actions?: { text: string; onPress: () => void }[];
    cancel?: string;
    more?: string;
    colorScheme?: string;
  };
  expect(opened?.options).toBeUndefined();
  expect(opened?.cancel).toBe("Cancel");
  expect(opened?.more).toBe("More");
  expect(opened?.colorScheme).toBe("light");
  const choice = opened?.actions?.find((action) => action.text === "openai · Reviewer");
  expect(choice).toBeTruthy();
  await act(async () => choice!.onPress());
  expect(request).toHaveBeenCalledWith(
    "learning/setReviewer",
    expect.objectContaining({
      expectedRevision: 0,
      pin: expect.objectContaining({
        runtimeKind: "pi",
        provider: "openai",
        modelId: "reviewer",
        credentialId: "cred",
      }),
    }),
  );
  const payload = request.mock.calls.find((call) => call[0] === "learning/setReviewer")?.[1] as {
    pin: { revision?: number };
  };
  expect(payload.pin.revision).toBeUndefined();
  const afterSave = [...node.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Reviewer:"),
  );
  expect(afterSave?.textContent).toBe("Reviewer: reviewer");
});

it("saves a Codex reviewer chosen from the runtime list", async () => {
  learningSettings.mockResolvedValue({
    enabled: true,
    canConfigure: true,
    reviewerPin: null,
    consolidationEnabled: false,
    budgets: {},
    destination: null,
  });
  request.mockImplementation(async (procedure: string, body?: { runtimeKind?: string }) => {
    if (procedure === "me") return { isDeploymentOwner: true };
    if (procedure === "board/workspaces") return { workspaces: [workspace], problem: null };
    if (procedure === "bots/list") return [];
    if (procedure === "board/upkeep") return { enabled: false };
    if (procedure === "models/list" || procedure === "models/credentials") return [];
    if (procedure === "runtimes/availability") {
      return body?.runtimeKind === "codex-app-server"
        ? {
            available: true,
            models: [{ id: "gpt-6-sol", label: "Sol", efforts: ["medium", "high"] }],
          }
        : { available: false, models: [] };
    }
    if (procedure === "learning/setReviewer") {
      return {
        enabled: true,
        canConfigure: true,
        consolidationEnabled: false,
        reviewerPin: null,
        budgets: {},
        destination: null,
      };
    }
    throw new Error(`Unexpected ${procedure}`);
  });
  await act(async () => root.render(createElement(BoardsSettings)));
  const runtime = [...node.querySelectorAll("button")].find(
    (button) => button.textContent === "Ardur (built-in)",
  );
  expect(runtime).toBeTruthy();
  await act(async () => runtime!.click());
  const runtimeSheet = sheet.mock.calls.at(-1)?.[0] as {
    actions: { text: string; onPress: () => void }[];
  };
  expect(runtimeSheet.actions.map((action) => action.text)).toEqual([
    "Ardur (built-in)",
    "Claude Code (your claude sign-in)",
    "Codex (your ChatGPT sign-in)",
    "Antigravity",
    "Hermes",
  ]);
  await act(async () =>
    runtimeSheet.actions.find((action) => action.text.startsWith("Codex"))!.onPress(),
  );
  const model = [...node.querySelectorAll("button")].find(
    (button) => button.textContent === "Choose a model",
  );
  expect(model).toBeTruthy();
  await act(async () => model!.click());
  const modelSheet = sheet.mock.calls.at(-1)?.[0] as {
    actions: { text: string; onPress: () => void }[];
  };
  await act(async () => modelSheet.actions.find((action) => action.text === "Sol")!.onPress());
  expect(request).toHaveBeenCalledWith(
    "learning/setReviewer",
    expect.objectContaining({
      pin: expect.objectContaining({
        runtimeKind: "codex-app-server",
        provider: "openai-codex",
        modelId: "gpt-6-sol",
        credentialId: "native:codex-app-server",
      }),
    }),
  );
});

it("sends a thinking change as a choice, with the revision beside it", async () => {
  learningSettings.mockResolvedValue({
    enabled: true,
    canConfigure: true,
    consolidationEnabled: false,
    budgets: {},
    destination: null,
    reviewerPin: {
      runtimeKind: "pi",
      provider: "openai",
      modelId: "reviewer",
      credentialId: "cred",
      effort: "medium",
      revision: 4,
    },
  });
  request.mockImplementation(async (procedure: string) => {
    if (procedure === "me") return { isDeploymentOwner: true };
    if (procedure === "board/workspaces") return { workspaces: [workspace], problem: null };
    if (procedure === "bots/list") return [];
    if (procedure === "board/upkeep") return { enabled: false };
    if (procedure === "models/list") {
      return [
        {
          provider: "openai",
          id: "reviewer",
          label: "Reviewer",
          billing: "usage",
          thinkingLevels: ["medium", "high"],
        },
      ];
    }
    if (procedure === "models/credentials") {
      return [{ id: "cred", provider: "openai", label: "OpenAI", hasKey: true, isDefault: true }];
    }
    if (procedure === "runtimes/availability") return { available: false, models: [] };
    if (procedure === "learning/setReviewer") {
      return {
        enabled: true,
        canConfigure: true,
        consolidationEnabled: false,
        reviewerPin: null,
        budgets: {},
        destination: null,
      };
    }
    throw new Error(`Unexpected ${procedure}`);
  });
  await act(async () => root.render(createElement(BoardsSettings)));
  const thinking = [...node.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Thinking:"),
  );
  expect(thinking?.textContent).toBe("Thinking: Medium");
  await act(async () => thinking!.click());
  const opened = sheet.mock.calls.at(-1)?.[0] as {
    actions: { text: string; onPress: () => void }[];
  };
  await act(async () => opened.actions.find((action) => action.text === "High")!.onPress());
  const saved = request.mock.calls.find((call) => call[0] === "learning/setReviewer")?.[1] as {
    expectedRevision: number;
    pin: Record<string, unknown>;
  };
  expect(saved.expectedRevision).toBe(4);
  expect(saved.pin).toEqual({
    runtimeKind: "pi",
    provider: "openai",
    modelId: "reviewer",
    credentialId: "cred",
    effort: "high",
  });
  expect(SetLearningReviewerInput.parse(saved)).toEqual(saved);
});

it("opens the model screen when no reviewer choice is available", async () => {
  learningSettings.mockResolvedValue({
    enabled: false,
    canConfigure: true,
    reviewerPin: null,
    consolidationEnabled: false,
    budgets: {},
    destination: null,
  });
  await act(async () => root.render(createElement(BoardsSettings)));
  const connect = [...node.querySelectorAll("button")].find(
    (button) => button.textContent === "Choose a model",
  );
  expect(connect).toBeTruthy();
  await act(async () => connect!.click());
  expect(push).toHaveBeenCalledWith("/models");
  expect(sheet).not.toHaveBeenCalled();
});
