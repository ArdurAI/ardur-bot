// @vitest-environment jsdom

import { ORPCError } from "@orpc/client";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { SettingsPageProps } from "../settings-types";
import BoardsSettings from "./BoardsSettings";

const api = vi.hoisted(() => ({
  workspaces: vi.fn(),
  configure: vi.fn(),
  start: vi.fn(),
  bots: vi.fn(),
  upkeep: vi.fn(async () => ({ enabled: true })),
  setUpkeep: vi.fn(async ({ enabled }: { enabled: boolean }) => ({ enabled })),
  learning: vi.fn(async () => ({
    enabled: false,
    consolidationEnabled: false,
    reviewerPin: null as null | {
      runtimeKind: string;
      provider: string;
      modelId: string;
      credentialId: string;
      effort: string | null;
      revision: number;
    },
    budgets: {
      botDailyTokens: 30000,
      spaceDailyTokens: 150000,
      maxProposals: 3,
      timeoutMs: 30000,
      maxOutputTokens: 2000,
      maxOutputChars: 12000,
    },
    destination: {
      runtimeKind: "pi",
      provider: "openai",
      modelId: "reviewer",
      effort: "medium",
      credentialId: "cred",
      revision: 1,
    },
    canConfigure: true,
  })),
  enableLearning: vi.fn(),
  setReviewer: vi.fn(),
  me: vi.fn(async () => ({ defaultProvider: "openai", defaultModel: "reviewer" })),
  modelsList: vi.fn(async () => [
    { provider: "openai", id: "reviewer", thinkingLevels: ["medium", "high"] },
  ]),
  modelsCredentials: vi.fn(async () => [{ id: "cred", provider: "openai", label: "OpenAI" }]),
  availability: vi.fn(
    async (_input: {
      runtimeKind: string;
    }): Promise<{
      runtimeKind?: string;
      available: boolean;
      signedIn?: boolean;
      models: { id: string; label: string; efforts: string[] }[];
    }> => ({
      available: false,
      models: [],
    }),
  ),
}));
vi.mock("../../lib/rpc", () => ({
  selectedSpaceId: () => "space",
  rpc: {
    board: api,
    bots: { list: api.bots },
    learning: {
      settings: api.learning,
      configure: api.enableLearning,
      setReviewer: api.setReviewer,
    },
    me: api.me,
    models: { list: api.modelsList, credentials: api.modelsCredentials },
    runtimes: { availability: api.availability },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  SuccessPop: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: ComponentProps<"button"> & {
    checked?: boolean;
    onCheckedChange?: (value: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
}));
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});
function serverError(message: string) {
  return new ORPCError("BAD_REQUEST", { message });
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function render(
  initialized = true,
  allowedBotIds: string[] = [],
  options: { allowAllBots?: boolean; second?: boolean } = {},
) {
  api.workspaces.mockResolvedValue({
    workspaces: [
      {
        id: "workspace",
        name: "Planning",
        kind: "folder",
        path: "/fixture/project",
        prefix: "work",
        enabled: true,
        initialized,
        isDefault: false,
        allowAllBots: options.allowAllBots ?? false,
        allowedBotIds,
      },
      ...(options.second
        ? [
            {
              id: "other",
              name: "Archive",
              kind: "folder" as const,
              path: "/fixture/other",
              prefix: "other",
              enabled: true,
              initialized: true,
              isDefault: false,
              allowAllBots: true,
              allowedBotIds: [] as string[],
            },
          ]
        : []),
    ],
    problem: null,
  });
  api.bots.mockResolvedValue([{ id: "builder", name: "Builder" }]);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  await act(async () =>
    root.render(
      <BoardsSettings
        {...({ onBusyChange: vi.fn(), navigate: vi.fn() } as unknown as SettingsPageProps)}
      />,
    ),
  );
  return node;
}
const button = (node: HTMLElement, label: string) =>
  [...node.querySelectorAll("button")].find((button) => button.textContent === label)!;
it("removes unavailable bots when saving the remaining allowlist", async () => {
  const node = await render(true, ["archived", "deleted"]);
  await act(async () => node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(api.configure).toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { allowedBotIds: ["builder"] },
  });
});
it("initializes only after Settings confirmation and shows the files affected", async () => {
  const node = await render(false);
  expect(api.start).not.toHaveBeenCalled();
  await act(async () => button(node, "Start board").click());
  expect(node.querySelector('[role="dialog"]')?.textContent).toContain(".beads/");
  expect(api.start).not.toHaveBeenCalled();
  await act(async () => button(node, "Confirm").click());
  expect(api.start).toHaveBeenCalledWith({ workspaceId: "workspace" });
});
it("keeps a failed start open and shows the server sentence beside the action", async () => {
  api.start.mockRejectedValueOnce(serverError("This folder already has a board."));
  const node = await render(false);
  await act(async () => button(node, "Start board").click());
  await act(async () => button(node, "Confirm").click());
  expect(node.querySelector('[role="dialog"]')?.textContent).toContain(
    "This folder already has a board.",
  );
  expect(node.textContent).not.toContain("Could not load");
});
it("shows a failed save sentence beside the name control", async () => {
  api.configure.mockRejectedValueOnce(serverError("This name could not be saved."));
  const node = await render();
  await act(async () => node.querySelector("form")!.requestSubmit());
  expect(node.querySelector("form")?.parentElement?.textContent).toContain(
    "This name could not be saved.",
  );
  expect(node.textContent).not.toContain("Could not load");
});
it("saves the default and bot allowlist and confirms reversible archive", async () => {
  const node = await render();
  await act(async () => button(node, "Make default").click());
  expect(api.configure).toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { isDefault: true },
  });
  await act(async () => node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(api.configure).toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { allowedBotIds: ["builder"] },
  });
  await act(async () => button(node, "Archive board").click());
  expect(node.querySelector('[role="dialog"]')?.textContent).toContain("Board files will be kept.");
  expect(api.configure).not.toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { enabled: false },
  });
  await act(async () => button(node, "Confirm").click());
  expect(api.configure).toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { enabled: false },
  });
});
it("shows a refresh failure when starting succeeds and reloading does not", async () => {
  const node = await render(false);
  api.start.mockResolvedValueOnce({ ok: true });
  api.workspaces.mockRejectedValueOnce(serverError("Could not refresh this board."));
  await act(async () => button(node, "Start board").click());
  await act(async () => button(node, "Confirm").click());
  expect(node.querySelector('[role="dialog"]')).toBeNull();
  expect(node.textContent).toContain("Not initialized");
  expect(node.querySelector('[data-settings-row="Beads"]')?.textContent).toContain(
    "Could not refresh this board.",
  );
});
it("shows a failed change to selected bots while every bot stays allowed", async () => {
  api.configure.mockRejectedValueOnce(serverError("Could not save the bot list."));
  const node = await render(true, [], { allowAllBots: true });
  const select = node.querySelector<HTMLSelectElement>('select[aria-label="Allowed bots"]')!;
  expect(select.value).toBe("all");
  await choose(select, "selected");
  expect(api.configure).toHaveBeenCalledWith({
    workspaceId: "workspace",
    patch: { allowAllBots: false },
  });
  expect(select.value).toBe("all");
  expect(node.querySelector('[data-settings-row="Allowed bots"]')?.textContent).toContain(
    "Could not save the bot list.",
  );
});
it("clears a rename failure when the selected board changes", async () => {
  api.configure.mockRejectedValueOnce(serverError("This name could not be saved."));
  const node = await render(true, [], { second: true });
  await act(async () => node.querySelector("form")!.requestSubmit());
  expect(node.textContent).toContain("This name could not be saved.");
  await choose(node.querySelector<HTMLSelectElement>('select[aria-label="Board"]')!, "other");
  expect(node.textContent).not.toContain("This name could not be saved.");
  expect(node.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe("Archive");
});
it("keeps the board picker locked until a pending action settles", async () => {
  let reject: (error: unknown) => void = () => {};
  api.configure.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const node = await render(true, [], { second: true });
  await act(async () => node.querySelector("form")!.requestSubmit());
  const picker = node.querySelector<HTMLSelectElement>('select[aria-label="Board"]')!;
  expect(picker.disabled).toBe(true);
  await act(async () => {
    reject(serverError("This name could not be saved."));
  });
  expect(picker.disabled).toBe(false);
  expect(node.querySelector("form")?.parentElement?.textContent).toContain(
    "This name could not be saved.",
  );
});
it("shows a server sentence and hides a browser fetch failure", async () => {
  api.configure.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const node = await render();
  await act(async () => node.querySelector("form")!.requestSubmit());
  expect(node.querySelector("form")?.parentElement?.textContent).toContain(
    "Could not complete this action.",
  );
  expect(node.textContent).not.toContain("Failed to fetch");
  api.configure.mockRejectedValueOnce(serverError("This name could not be saved."));
  await act(async () => node.querySelector("form")!.requestSubmit());
  expect(node.querySelector("form")?.parentElement?.textContent).toContain(
    "This name could not be saved.",
  );
});
it("shows a failed upkeep change beside its switch", async () => {
  api.setUpkeep.mockRejectedValueOnce(serverError("Could not change this setting."));
  const node = await render();
  await act(async () => node.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(
    node.querySelector('[data-settings-row="Bots keep the board and memory current"]')?.textContent,
  ).toContain("Could not change this setting.");
});
it("covers learning switch, model change, level change, no connection, CONFLICT and old text removal", async () => {
  api.enableLearning.mockResolvedValue({ ...(await api.learning()), enabled: true });
  const saved = {
    ...(await api.learning()),
    enabled: true,
    reviewerPin: {
      runtimeKind: "pi",
      provider: "openai",
      modelId: "reviewer",
      credentialId: "cred",
      effort: "high",
      revision: 2,
    },
  };
  api.setReviewer.mockResolvedValue(saved);

  const node = await render();

  // Verify old text is gone
  expect(node.textContent).not.toContain("Learning review is on");
  expect(node.textContent).not.toContain("Learning review is off");
  expect(node.textContent).not.toContain("Reviewer:");
  expect(node.textContent).not.toContain("No reviewer model yet.");

  // Learning review is a switch
  const switchElement = node.querySelector<HTMLButtonElement>('[aria-label="Learning review"]');
  expect(switchElement).not.toBeNull();

  await act(async () => switchElement!.click());
  expect(api.enableLearning).toHaveBeenCalledWith(
    expect.objectContaining({ enabled: true, reviewerPin: null }),
  );

  // Model change selects a rendered connection key, not a hand-built colon string.
  const reviewerSelect = node.querySelector<HTMLSelectElement>("#learning-reviewer");
  expect(reviewerSelect).not.toBeNull();
  const rendered = [...reviewerSelect!.options].find((option) => option.value.startsWith("["));
  expect(rendered?.value).toBe(JSON.stringify(["openai", "reviewer", "cred"]));
  // The server persists the choice, so the reload after the save must show it.
  api.learning.mockResolvedValue(saved);
  await choose(reviewerSelect!, rendered!.value);
  expect(api.setReviewer).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedRevision: 0,
      pin: expect.objectContaining({
        provider: "openai",
        modelId: "reviewer",
        credentialId: "cred",
        effort: "medium",
      }),
    }),
  );
  const reloadedReviewer = node.querySelector<HTMLSelectElement>("#learning-reviewer");
  expect(reloadedReviewer?.value).toBe(JSON.stringify(["openai", "reviewer", "cred"]));
  const effortSelect = node.querySelector<HTMLSelectElement>("#learning-reviewer-effort");
  expect(effortSelect).not.toBeNull();
  expect(effortSelect?.value).toBe("high");

  // Level change sends the reloaded revision.
  await act(async () => {
    effortSelect!.value = "medium";
    effortSelect!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(api.setReviewer).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedRevision: 2,
      pin: expect.objectContaining({ effort: "medium" }),
    }),
  );

  // A real CONFLICT reloads the settings and shows the conflict sentence.
  const loadsBefore = api.learning.mock.calls.length;
  api.setReviewer.mockRejectedValueOnce(
    new ORPCError("CONFLICT", { message: "The reviewer was changed in another window." }),
  );
  await act(async () => {
    effortSelect!.value = "high";
    effortSelect!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(api.learning.mock.calls.length).toBeGreaterThan(loadsBefore);
  expect(node.querySelector('[data-settings-row="Learning reviewer"]')?.textContent).toContain(
    "The reviewer was changed in another window.",
  );
});

it("shows connect a model when no connection can be chosen", async () => {
  const current = await api.learning();
  api.learning.mockResolvedValue({ ...current, reviewerPin: null });
  api.modelsCredentials.mockResolvedValue([]);
  const node = await render();
  expect(button(node, "Connect a model")).toBeTruthy();
});

it("offers Codex when that sign-in is usable and no model connection is stored", async () => {
  api.modelsCredentials.mockResolvedValue([]);
  api.availability.mockImplementation(async ({ runtimeKind }: { runtimeKind: string }) =>
    runtimeKind === "codex-app-server"
      ? {
          runtimeKind,
          available: true,
          signedIn: true,
          models: [{ id: "gpt-6-sol", label: "Sol", efforts: ["medium", "high"] }],
        }
      : { runtimeKind, available: false, models: [] },
  );
  const node = await render();
  expect(node.querySelector('[aria-label="Learning review"]')).not.toBeNull();
  expect(node.textContent).not.toContain("Connect a model");
  const runtime = node.querySelector<HTMLSelectElement>("#learning-reviewer-runtime");
  expect(runtime).not.toBeNull();
  expect([...runtime!.options].map((option) => option.value)).toEqual([
    "pi",
    "claude-code",
    "codex-app-server",
    "antigravity",
    "hermes",
  ]);
  await choose(runtime!, "codex-app-server");
  const model = node.querySelector<HTMLSelectElement>("#learning-reviewer-native-model");
  expect([...model!.options].some((option) => option.value === "gpt-6-sol")).toBe(true);
  await choose(model!, "gpt-6-sol");
  expect(api.setReviewer).toHaveBeenCalledWith(
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

it("keeps a saved Codex reviewer when no connection rows are stored", async () => {
  const current = await api.learning();
  api.learning.mockResolvedValue({
    ...current,
    reviewerPin: {
      runtimeKind: "codex-app-server",
      provider: "openai-codex",
      modelId: "gpt-6-sol",
      credentialId: "native:codex-app-server",
      effort: "medium",
      revision: 4,
    },
  });
  api.modelsCredentials.mockResolvedValue([]);
  const node = await render();
  expect(node.querySelector('[aria-label="Learning review"]')).not.toBeNull();
  expect(node.querySelector<HTMLSelectElement>("#learning-reviewer-runtime")?.value).toBe(
    "codex-app-server",
  );
});

it("still asks to connect a model when only Hermes is available", async () => {
  const current = await api.learning();
  api.learning.mockResolvedValue({ ...current, reviewerPin: null });
  api.modelsCredentials.mockResolvedValue([]);
  api.availability.mockImplementation(async ({ runtimeKind }: { runtimeKind: string }) =>
    runtimeKind === "hermes"
      ? {
          runtimeKind,
          available: true,
          models: [{ id: "local-model", label: "Local", efforts: ["off"] }],
        }
      : { runtimeKind, available: false, models: [] },
  );
  const node = await render();
  expect(button(node, "Connect a model")).toBeTruthy();
  expect(node.querySelector('[aria-label="Learning review"]')).toBeNull();
  api.availability.mockImplementation(async () => ({
    available: false,
    models: [] as { id: string; label: string; efforts: string[] }[],
  }));
});

it("says why a saved Hermes reviewer on a sign-in connection cannot run", async () => {
  const current = await api.learning();
  api.learning.mockResolvedValue({
    ...current,
    reviewerPin: {
      runtimeKind: "hermes",
      provider: "openai-codex",
      modelId: "gpt-6-sol",
      credentialId: "chatgpt",
      effort: "medium",
      revision: 2,
    },
  });
  api.modelsList.mockResolvedValue([
    { provider: "openai-codex", id: "gpt-6-sol", thinkingLevels: ["medium"] },
    { provider: "openai-compatible", id: "local-model", thinkingLevels: ["off"] },
  ]);
  const connections: { id: string; provider: string; label: string; oauth?: boolean }[] = [
    { id: "chatgpt", provider: "openai-codex", label: "ChatGPT", oauth: true },
    { id: "local", provider: "openai-compatible", label: "Local" },
  ];
  api.modelsCredentials.mockResolvedValue(connections);
  const node = await render();
  expect(node.querySelector<HTMLSelectElement>("#learning-reviewer-runtime")?.value).toBe("hermes");
  expect(node.querySelector('[role="status"]')?.textContent).toBe(
    "ChatGPT sign-ins only work inside Codex; add an OpenAI API key to use GPT models with Hermes.",
  );
  const reviewer = node.querySelector<HTMLSelectElement>("#learning-reviewer")!;
  const option = (provider: string) =>
    [...reviewer.options].find((entry) => entry.value.includes(`"${provider}"`));
  expect(option("openai-codex")?.disabled).toBe(true);
  expect(option("openai-compatible")?.disabled).toBe(false);
  // Another runtime for the reviewer: the line goes with it.
  await choose(node.querySelector<HTMLSelectElement>("#learning-reviewer-runtime")!, "pi");
  expect(node.querySelector('[role="status"]')).toBeNull();
  api.learning.mockResolvedValue(current);
});

it("saves Hermes and Antigravity reviewers as those runtimes", async () => {
  api.modelsList.mockResolvedValue([
    { provider: "openai-compatible", id: "local-model", thinkingLevels: ["off", "medium"] },
  ]);
  api.modelsCredentials.mockResolvedValue([
    { id: "local", provider: "openai-compatible", label: "Local" },
  ]);
  api.availability.mockImplementation(async ({ runtimeKind }: { runtimeKind: string }) =>
    runtimeKind === "antigravity"
      ? {
          runtimeKind,
          available: true,
          models: [{ id: "gemini-3.1-pro-high", label: "Pro", efforts: ["high"] }],
        }
      : { runtimeKind, available: false, models: [] },
  );
  const node = await render();
  const runtime = node.querySelector<HTMLSelectElement>("#learning-reviewer-runtime")!;
  await choose(runtime, "hermes");
  const reviewer = node.querySelector<HTMLSelectElement>("#learning-reviewer")!;
  const rendered = [...reviewer.options].find((option) => option.value.startsWith("["));
  expect(rendered?.value).toBe(JSON.stringify(["openai-compatible", "local-model", "local"]));
  await choose(reviewer, rendered!.value);
  expect(api.setReviewer).toHaveBeenCalledWith(
    expect.objectContaining({
      pin: expect.objectContaining({
        runtimeKind: "hermes",
        provider: "openai-compatible",
        modelId: "local-model",
        credentialId: "local",
      }),
    }),
  );

  await choose(runtime, "antigravity");
  const native = node.querySelector<HTMLSelectElement>("#learning-reviewer-native-model")!;
  expect([...native.options].some((option) => option.value === "gemini-3.1-pro-high")).toBe(true);
  await choose(native, "gemini-3.1-pro-high");
  expect(api.setReviewer).toHaveBeenCalledWith(
    expect.objectContaining({
      pin: expect.objectContaining({
        runtimeKind: "antigravity",
        provider: "antigravity",
        modelId: "gemini-3.1-pro-high",
        credentialId: "native:antigravity",
        effort: "high",
      }),
    }),
  );
});
