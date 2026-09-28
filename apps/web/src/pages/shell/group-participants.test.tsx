// @vitest-environment jsdom
import type { Bot, Group, Run } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
}));

import type { ModelSettings } from "../../lib/use-model-settings";
import { GroupParticipantModels } from "./group-participants";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const bots = [
  { id: "b1", name: "Alpha", runtimeKind: "pi", modelProvider: "openai", modelId: "gpt-4" },
  { id: "b2", name: "Beta", runtimeKind: "pi", modelProvider: "anthropic", modelId: "claude-3" },
] as Bot[];

const modelSettings = {
  me: { defaultProvider: "openai", defaultModel: "gpt-4" },
  catalog: [
    { provider: "openai", id: "gpt-4", providerName: "OpenAI", label: "GPT-4" },
    { provider: "anthropic", id: "claude-3", providerName: "Anthropic", label: "Claude 3" },
  ],
  credentials: [
    { id: "cred-1", provider: "openai", modelId: "gpt-4", hasKey: true },
    { id: "cred-2", provider: "anthropic", modelId: "claude-3", hasKey: true },
  ],
} as ModelSettings;

function group(): Group {
  return {
    id: "g1",
    spaceId: "s1",
    name: "Group",
    members: [
      { botId: "b1", name: "Alpha", color: "blue", effectiveRuntimePin: null },
      { botId: "b2", name: "Beta", color: "red", effectiveRuntimePin: null },
    ],
  } as Group;
}

async function render(currentRuns: readonly Run[] = []) {
  await act(async () => {
    root.render(
      <GroupParticipantModels
        activeGroup={group()}
        bots={bots}
        currentRuns={currentRuns}
        modelSettings={modelSettings}
      />,
    );
  });
  return container.querySelector('[data-testid="group-participant-models"]')!;
}

it("joins member names and models with spaced separators on one truncating line", async () => {
  const div = await render();
  const full = "Alpha · Ardur · OpenAI · GPT-4 · Beta · Ardur · Anthropic · Claude 3";
  expect(div.textContent).toBe(full);
  expect(div.className).toContain("truncate");
  expect(div.className).toContain("min-w-0");
  // The full text stays available on hover and in the accessibility tree.
  expect(div.getAttribute("title")).toBe(full);
  expect(div.querySelector('[data-testid="group-participant-b1"]')).not.toBeNull();
  expect(div.querySelector('[data-testid="group-participant-b2"]')).not.toBeNull();
  expect(
    div
      .querySelector('[data-testid="group-participant-b1"] [role="status"]')
      ?.getAttribute("aria-label"),
  ).toBe("Using gpt-4");
  expect(
    div
      .querySelector('[data-testid="group-participant-b2"] [role="status"]')
      ?.getAttribute("aria-label"),
  ).toBe("Using claude-3");
});

it("marks a member whose admitted run has no pin as Next run", async () => {
  const run = { id: "run-1", botId: "b1", status: "running", runtimePin: null } as Run;
  const div = await render([run]);
  expect(div.textContent).toBe(
    "Alpha · Next run · Ardur · OpenAI · GPT-4 · Beta · Ardur · Anthropic · Claude 3",
  );
  expect(
    div
      .querySelector('[data-testid="group-participant-b1"] [role="status"]')
      ?.getAttribute("aria-label"),
  ).toBe("Next run");
});
