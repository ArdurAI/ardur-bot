// @vitest-environment jsdom
import type { Comparison, ComparisonParticipant, ComparisonResult } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ComparePanel } from "./ComparePanel";
import { CompareStart } from "./CompareStart";

const calls = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  merge: vi.fn(),
  previewMerge: vi.fn(),
  preview: vi.fn(),
  create: vi.fn(),
  answer: vi.fn(),
  export: vi.fn(),
  download: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    comparisons: calls,
    bots: { list: calls.list },
    threads: { answer: calls.answer },
    export: { comparison: calls.export },
  },
}));
vi.mock("../lib/artifact-open", () => ({ downloadArtifactBytes: calls.download }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@ardurbot/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock("../components/AskCard", () => ({
  AskCard: ({ onAnswer }: { onAnswer: (text: string) => Promise<void> }) => (
    <button type="button" onClick={() => void onAnswer("allow")}>
      Allow participant
    </button>
  ),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ children, ...props }: ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
  Checkbox: ({
    onCheckedChange,
    ...props
  }: ComponentProps<"input"> & { onCheckedChange: (value: boolean) => void }) => (
    <input {...props} type="checkbox" onChange={(event) => onCheckedChange(event.target.checked)} />
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));
const participant = (botId: string): ComparisonParticipant => ({
  botId,
  name: botId,
  executing: {
    pin: {
      runtimeKind: "pi",
      provider: "fixture",
      modelId: `model-${botId}`,
      effort: "high",
      credentialId: "connection",
      revision: 1,
    },
    computer: { id: "computer", kind: "test", mode: "team" },
    destination: { local: true, host: "localhost" },
  },
});
const result = (botId: string): ComparisonResult => ({
  botId,
  runId: `run-${botId}`,
  delegationId: `delegation-${botId}`,
  status: botId === "a" ? "waiting-approval" : "completed",
  output: `Output ${botId}`,
  outputMessageIds: [`output-${botId}`],
  outputArtifactIds: [],
  citations: ["https://example.test/source"],
  usage: { inputTokens: 20, outputTokens: 10, reported: true, costs: [] },
  durationMs: 1000,
  startedAt: null,
  completedAt: null,
  failure: null,
  provenance: {
    reportedModel: null,
    reportedModelVersion: null,
    memoryRead: false,
    memoryDiffered: false,
    ambientHistory: false,
    toolsRestricted: true,
  },
  approvals:
    botId === "a"
      ? [{ messageId: "approval-a", block: { kind: "ask", text: "Allow?", status: "pending" } }]
      : [],
});
const comparison = {
  id: "comparison",
  coordinatorBotId: "a",
  participants: [participant("a"), participant("b")],
  results: [result("b"), result("a")],
  snapshot: { text: "Frozen task", environmentNote: "Environment", artifacts: [] },
  budget: { mergeReserved: true },
  merge: null,
} as unknown as Comparison;

it("keeps participant order, renders unknown provenance, answers one card, and merges only the selected run", async () => {
  calls.get.mockResolvedValue(comparison);
  calls.list.mockResolvedValue([
    { id: "a", name: "a" },
    { id: "b", name: "b" },
  ]);
  calls.previewMerge.mockResolvedValue(participant("a"));
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(<ComparePanel id="comparison" onClose={() => {}} />));
  expect(
    [...node.querySelectorAll("[data-comparison-bot]")].map((element) =>
      element.getAttribute("data-comparison-bot"),
    ),
  ).toEqual(["a", "b"]);
  expect(node.textContent).toContain("Waiting for approval");
  expect(node.textContent).toContain("Not reported");
  expect(node.textContent).not.toMatch(/winner|score|ranking|\$0/i);
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent === "Allow participant")!
      .click(),
  );
  expect(calls.answer).toHaveBeenCalledWith({
    botId: "a",
    runId: "run-a",
    messageId: "approval-a",
    answer: "allow",
  });
  await act(async () =>
    node.querySelector<HTMLInputElement>('[data-comparison-bot="b"] input')!.click(),
  );
  const merge = () =>
    [...node.querySelectorAll("button")].find((button) =>
      /Preview merge|Merge selected/.test(button.textContent ?? ""),
    )!;
  await act(async () => merge().click());
  expect(calls.previewMerge).toHaveBeenCalledWith({ id: "comparison", botId: "a" });
  await act(async () => merge().click());
  expect(calls.merge).toHaveBeenCalledWith(
    expect.objectContaining({
      botId: "a",
      selectedRunIds: ["run-b"],
      expectedParticipant: participant("a"),
    }),
  );
  const exported = { version: 1, comparison };
  calls.export.mockResolvedValue(exported);
  await act(async () =>
    [...node.querySelectorAll("button")]
      .find((button) => button.textContent === "Export JSON")!
      .click(),
  );
  expect(calls.export).toHaveBeenCalledWith({ id: "comparison" });
  expect(calls.download).toHaveBeenCalled();
  await act(async () => root.unmount());
});
it("includes the current bot and requires the per-pin budget preview before start", async () => {
  calls.list.mockResolvedValue([
    { id: "a", name: "a" },
    { id: "b", name: "b" },
  ]);
  calls.preview.mockResolvedValue({
    participants: [participant("a"), participant("b")],
    runs: 3,
    tokens: 30000,
  });
  calls.create.mockResolvedValue(comparison);
  calls.get.mockResolvedValue(comparison);
  const node = document.createElement("div");
  const root = createRoot(node);
  const onCreated = vi.fn();
  await act(async () =>
    root.render(<CompareStart botId="a" text="One task" onCreated={onCreated} />),
  );
  const button = (label: string) =>
    [...node.querySelectorAll("button")].find((button) => button.textContent === label)!;
  await act(async () => button("Compare with…").click());
  expect(node.querySelector<HTMLInputElement>("#compare-bot-a")!.disabled).toBe(true);
  await act(async () => node.querySelector<HTMLInputElement>("#compare-bot-b")!.click());
  await act(async () => button("Preview").click());
  expect(node.textContent).toContain("hosted providers may bill per run");
  await act(async () => button("Start comparison").click());
  expect(calls.create).toHaveBeenCalledWith(
    expect.objectContaining({
      participantBotIds: ["a", "b"],
      text: "One task",
      expectedParticipants: [participant("a"), participant("b")],
    }),
  );
  expect(onCreated).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});
