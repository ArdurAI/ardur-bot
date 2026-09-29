// @vitest-environment jsdom
import type {
  Bot,
  Group,
  GroupMember,
  ProductEvent,
  Run,
  ThreadSnapshot,
} from "@ardurbot/contracts";
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

import { activeThreadRuns, reduceThreadSnapshot } from "../../lib/thread-events";
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

const pin = {
  runtimeKind: "pi" as const,
  provider: "openai",
  modelId: "gpt-4",
  effort: null,
  credentialId: "cred-1",
  revision: 2,
};

function group(members: GroupMember[] = defaultMembers()): Group {
  return {
    id: "g1",
    spaceId: "s1",
    name: "Group",
    members,
  } as Group;
}

function defaultMembers(): GroupMember[] {
  return [
    { botId: "b1", name: "Alpha", color: "blue", effectiveRuntimePin: null },
    { botId: "b2", name: "Beta", color: "red", effectiveRuntimePin: null },
  ] as GroupMember[];
}

async function render(currentRuns: readonly Run[] = [], members = defaultMembers()) {
  await act(async () => {
    root.render(
      <GroupParticipantModels
        activeGroup={group(members)}
        bots={bots}
        currentRuns={currentRuns}
        modelSettings={modelSettings}
      />,
    );
  });
  return container.querySelector('[data-testid="group-participant-models"]')!;
}

it("joins member names and models on one line, with the full text in the hover title", async () => {
  const div = await render();
  const full = "Alpha · Ardur · OpenAI · GPT-4 | Beta · Ardur · Anthropic · Claude 3";
  expect(div.textContent).toBe(full);
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

it("renders member names in regular text colour and model details as muted", async () => {
  const div = await render();
  const participant = div.querySelector('[data-testid="group-participant-b1"]')!;
  const name = participant.querySelector(".text-foreground");
  const details = participant.querySelector(".text-muted-foreground");
  const status = participant.querySelector('[role="status"]');

  expect(name).not.toBeNull();
  expect(name?.textContent).toBe("Alpha");
  expect(name?.className).toContain("text-foreground");
  expect(name?.className).not.toContain("text-muted-foreground");

  expect(details).not.toBeNull();
  expect(details?.className).toContain("text-muted-foreground");
  expect(details?.className).not.toContain("text-foreground");
  expect(details?.contains(status!)).toBe(true);
});

it("separates members with a distinct separator that differs from intra-member separators", async () => {
  const div = await render();
  const participant = div.querySelector('[data-testid="group-participant-b1"]')!;
  const separator = div.querySelector('[data-testid="group-participant-separator"]');

  expect(separator).not.toBeNull();
  // Intra-member separator is " · "
  expect(participant.textContent).toContain(" · ");
  // The member separator differs from " · "
  expect(separator?.textContent?.trim()).not.toBe("·");
  expect(separator?.textContent).toBe(" | ");
  // Full muted colour, never faded with an opacity modifier, so it keeps readable contrast.
  expect(separator?.className.split(" ")).toContain("text-muted-foreground");
  expect(separator?.className).not.toMatch(/text-muted-foreground\/\d+/);
});

it("marks a member whose admitted run has no pin as Next run", async () => {
  const run = { id: "run-1", botId: "b1", status: "running", runtimePin: null } as Run;
  const div = await render([run]);
  expect(div.textContent).toBe(
    "Alpha · Next run · Ardur · OpenAI · GPT-4 | Beta · Ardur · Anthropic · Claude 3",
  );
  expect(
    div
      .querySelector('[data-testid="group-participant-b1"] [role="status"]')
      ?.getAttribute("aria-label"),
  ).toBe("Next run");
});

it("keeps the run's model and discloses the saved choice as the next run", async () => {
  const members = defaultMembers().map((member) =>
    member.botId === "b1" ? { ...member, effectiveRuntimePin: pin } : member,
  );
  const run = {
    id: "run-1",
    botId: "b1",
    status: "running",
    runtimePin: { ...pin, provider: "anthropic", modelId: "claude-3", credentialId: "cred-2" },
  } as Run;
  const div = await render([run], members);
  // The admitted run's model stays the active label…
  expect(
    div
      .querySelector('[data-testid="group-participant-b1"] [role="status"]')
      ?.getAttribute("aria-label"),
  ).toBe("Using claude-3");
  // …and the pending choice is disclosed as the next run, in text and in the hover title.
  expect(div.textContent).toContain(
    "Alpha · Ardur · Anthropic · Claude 3 · Next run · Ardur · openai · gpt-4 · cred-1",
  );
  expect(div.getAttribute("title")).toContain("Next run · Ardur · openai · gpt-4 · cred-1");
});

it("does not disclose a next run when the admitted pin already matches the saved choice", async () => {
  const members = defaultMembers().map((member) =>
    member.botId === "b1" ? { ...member, effectiveRuntimePin: pin } : member,
  );
  const run = {
    id: "run-1",
    botId: "b1",
    status: "running",
    runtimePin: { ...pin, revision: 1 },
  } as Run;
  const div = await render([run], members);
  expect(div.textContent).not.toContain("Next run");
  expect(
    div
      .querySelector('[data-testid="group-participant-b1"] [role="status"]')
      ?.getAttribute("aria-label"),
  ).toBe("Using gpt-4");
  expect(div.getAttribute("title")).not.toContain("Next run");
});

it.each([
  {
    change: "a runtime",
    next: { ...pin, runtimeKind: "claude-code" as const },
  },
  {
    change: "an effort",
    next: { ...pin, effort: "high" },
  },
  {
    change: "a connection",
    next: { ...pin, credentialId: "cred-2" },
  },
])("counts %s difference as a next-run change", async ({ change, next }) => {
  const members = defaultMembers().map((member) =>
    member.botId === "b1" ? { ...member, effectiveRuntimePin: next } : member,
  );
  const run = { id: "run-1", botId: "b1", status: "running", runtimePin: pin } as Run;
  const div = await render([run], members);
  expect(div.textContent, change).toContain("Next run");
  expect(div.getAttribute("title"), change).toContain(
    `Next run · ${next.runtimeKind === "pi" ? "Ardur" : "Claude Code"} · ${next.provider} · ${next.modelId}`,
  );
});

it("waits for a live run's admitted pin before showing Using", async () => {
  const snapshot: ThreadSnapshot = {
    groupId: "g1",
    threadId: "thread",
    cursor: 0,
    messages: [],
    olderCursor: null,
    run: null,
    activeRuns: [],
  };
  const start = {
    id: "event",
    spaceId: "space",
    threadId: "thread",
    botId: "b1",
    seq: 1,
    type: "run.started",
    runId: "run",
    createdAt: "2026-09-01T00:00:00Z",
    payload: {},
  } as ProductEvent;
  const members = defaultMembers().map((member) =>
    member.botId === "b1"
      ? { ...member, effectiveRuntimePin: { ...pin, modelId: "claude-3" } }
      : member,
  );
  const renderSnapshot = async (current: ThreadSnapshot | null) =>
    render(activeThreadRuns(current), members);

  const pending = reduceThreadSnapshot(snapshot, start);
  let div = await renderSnapshot(pending);
  expect(div.textContent).toContain("Next run");

  const admitted = reduceThreadSnapshot(pending!, {
    ...start,
    id: "admitted",
    seq: 2,
    payload: { runtimePin: pin },
  });
  div = await renderSnapshot(admitted);
  expect(
    div
      .querySelector('[data-testid="group-participant-b1"] [role="status"]')
      ?.getAttribute("aria-label"),
  ).toBe("Using gpt-4");
  expect(div.textContent).toContain("Next run");
});

it("shows the inherited next choice after clearing an active override", async () => {
  const run = {
    id: "run-1",
    botId: "b1",
    status: "running",
    runtimePin: { ...pin, provider: "anthropic", modelId: "claude-3", credentialId: "cred-2" },
  } as Run;
  const div = await render([run]);
  expect(
    div
      .querySelector('[data-testid="group-participant-b1"] [role="status"]')
      ?.getAttribute("aria-label"),
  ).toBe("Using claude-3");
  expect(div.textContent).toContain("Next run");
  expect(div.textContent).toContain("gpt-4");
});
