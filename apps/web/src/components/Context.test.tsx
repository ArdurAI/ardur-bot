// @vitest-environment jsdom
import type { Brief } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { rpc } from "../lib/rpc";
import { BotContext, BriefDocument, ContextMetrics, RunContext } from "./Context";

vi.mock("../lib/rpc", () => ({
  rpc: {
    briefs: { list: vi.fn(), update: vi.fn() },
    metrics: { context: vi.fn() },
    context: { settings: vi.fn() },
    bots: { update: vi.fn() },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: (props: ComponentProps<"button">) => <button {...props} />,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
const brief: Brief = {
  botId: "chief",
  groupId: "alpha",
  groupName: "Alpha",
  threadId: "thread-alpha",
  documentId: "document",
  revision: 4,
  content: "## Goal\nRelease Alpha",
  rewrittenAt: "2026-09-24T12:00:00Z",
  reason: null,
};

it("renders unknown measurements without inventing cache hits and displays the default route", async () => {
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <>
        <ContextMetrics />
        <RunContext run={{ routingRule: "default", contextSnapshot: null }} />
      </>,
    ),
  );
  expect(node.textContent).toContain("Routed by default");
  expect(node.textContent).toContain("Time to first token");
  expect(node.textContent).not.toContain("0%");
  expect(node.textContent).not.toContain("0 ms");
  await act(async () => root.unmount());
});
it("edits a brief with its revision and keeps an explicit conflict visible", async () => {
  vi.mocked(rpc.briefs.update)
    .mockResolvedValueOnce({ revision: 5 })
    .mockRejectedValueOnce(new Error("conflict"));
  const saved = vi.fn();
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(<BriefDocument brief={brief} saved={saved} />));
  expect(node.textContent).toContain("Release Alpha");
  await act(async () => node.querySelector("button")!.click());
  expect(node.querySelector("textarea")?.maxLength).toBe(6000);
  await act(async () => node.querySelector("button")!.click());
  expect(rpc.briefs.update).toHaveBeenCalledWith({
    botId: "chief",
    groupId: "alpha",
    content: brief.content,
    expectedRevision: 4,
  });
  expect(saved).toHaveBeenCalledOnce();
  await act(async () => node.querySelector("button")!.click());
  await act(async () => node.querySelector("button")!.click());
  expect(node.querySelector('[role="alert"]')?.textContent).toBe("Could not save changes");
  await act(async () => root.unmount());
});
it("loads two named group briefs and the concurrency setting on demand", async () => {
  vi.mocked(rpc.briefs.list).mockResolvedValue([
    brief,
    {
      ...brief,
      groupId: "beta",
      groupName: "Beta",
      threadId: "thread-beta",
      content: "## Goal\nPlan Beta",
    },
  ]);
  vi.mocked(rpc.metrics.context).mockResolvedValue({ today: [], sevenDays: [] });
  vi.mocked(rpc.context.settings).mockResolvedValue({ concurrentRuns: 3 } as never);
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () => root.render(<BotContext botId="chief" />));
  await act(async () => {
    const details = node.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  expect(node.textContent).toContain("Release Alpha");
  expect(node.textContent).toContain("Plan Beta");
  expect(node.querySelector("input")?.value).toBe("3");
  expect(rpc.briefs.list).toHaveBeenCalledWith({ botId: "chief", groupId: undefined });
  await act(async () => root.unmount());
});
