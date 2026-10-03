// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { rpc } from "../../../lib/rpc";
import { BotToolReview } from "./BotToolReview";

vi.mock("../../../lib/rpc", () => ({
  rpc: { integrations: { toolReview: vi.fn(), reviewTools: vi.fn(async () => ({ ok: true })) } },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (s: TemplateStringsArray) => s.join("") }),
}));
vi.mock("@ardurbot/ui-web", async () => {
  const { Checkbox } = await import("@ardurbot/ui-web/components/ui/checkbox");
  return {
    Dialog: ({ children }: { children: ReactNode }) => children,
    DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button {...props} />
    ),
    Checkbox,
  };
});
afterEach(() => vi.clearAllMocks());
const facts = {
  revision: 1,
  manifest: {
    capturedAt: "2026-10-02T00:00:00Z",
    account: null,
    serverVersion: null,
    tools: [
      {
        id: "read_item",
        description: "Read",
        inputSchemaDigest: "a".repeat(64),
        annotations: { readOnlyHint: true },
      },
      { id: "write_item", description: "Write", inputSchemaDigest: "b".repeat(64) },
      { id: "get_unknown", description: "Unknown", inputSchemaDigest: "c".repeat(64) },
    ],
  },
  spaceAllowedTools: ["read_item", "write_item", "get_unknown"],
  canApproveSpace: true,
  spaceNeedsReview: false,
};
it("preselects only annotated reads and grants nothing until selected is saved", async () => {
  vi.mocked(rpc.integrations.toolReview).mockResolvedValue(facts);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const saved = vi.fn();
  await act(async () =>
    root.render(
      <BotToolReview connectionId="connection" botId="bot" onClose={() => {}} onSaved={saved} />,
    ),
  );
  expect(node.querySelector<HTMLInputElement>('input[id$="-read_item"]')?.checked).toBe(true);
  expect(node.querySelector<HTMLInputElement>('input[id$="-write_item"]')?.checked).toBe(false);
  expect(node.querySelector<HTMLInputElement>('input[id$="-get_unknown"]')?.checked).toBe(false);
  const readInput = node.querySelector<HTMLInputElement>('input[id$="-read_item"]')!;
  const label = readInput.closest("label")!;
  const checkbox = label.querySelector('[role="checkbox"]')!;
  expect(checkbox.getAttribute("aria-labelledby")).toBe(label.id);
  expect(checkbox.hasAttribute("aria-label")).toBe(false);
  expect(label.textContent?.trim()).toBe("read_item");
  expect(rpc.integrations.reviewTools).not.toHaveBeenCalled();
  await act(async () =>
    Array.from(node.querySelectorAll("button"))
      .find((b) => b.textContent === "Allow selected")!
      .click(),
  );
  expect(rpc.integrations.reviewTools).toHaveBeenCalledWith({
    connectionId: "connection",
    revision: 1,
    botId: "bot",
    toolIds: ["read_item"],
    approveSpace: false,
  });
  expect(saved).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  node.remove();
});
it("saves all captured tools only after the explicit Allow all action", async () => {
  vi.mocked(rpc.integrations.toolReview).mockResolvedValue(facts);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(<BotToolReview connectionId="connection" onClose={() => {}} onSaved={() => {}} />),
  );
  expect(rpc.integrations.reviewTools).not.toHaveBeenCalled();
  await act(async () =>
    Array.from(node.querySelectorAll("button"))
      .find((b) => b.textContent === "Allow all")!
      .click(),
  );
  expect(rpc.integrations.reviewTools).toHaveBeenCalledWith({
    connectionId: "connection",
    revision: 1,
    botId: undefined,
    toolIds: ["read_item", "write_item", "get_unknown"],
    approveSpace: false,
  });
  await act(async () => root.unmount());
  node.remove();
});
it("requires a separate explicit choice before widening an empty space ceiling", async () => {
  vi.mocked(rpc.integrations.toolReview).mockResolvedValue({
    ...facts,
    spaceAllowedTools: [],
    spaceNeedsReview: true,
  });
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <BotToolReview connectionId="connection" botId="bot" onClose={() => {}} onSaved={() => {}} />,
    ),
  );
  const selected = Array.from(node.querySelectorAll("button")).find(
    (b) => b.textContent === "Allow selected",
  )!;
  expect(selected.disabled).toBe(true);
  expect(rpc.integrations.reviewTools).not.toHaveBeenCalled();
  await act(async () => node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(selected.disabled).toBe(false);
  await act(async () => selected.click());
  expect(rpc.integrations.reviewTools).toHaveBeenCalledWith(
    expect.objectContaining({ approveSpace: true, toolIds: ["read_item"] }),
  );
  await act(async () => root.unmount());
  node.remove();
});
