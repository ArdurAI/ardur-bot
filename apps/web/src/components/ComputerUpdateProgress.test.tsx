// @vitest-environment jsdom
import type { ComputerUpdate } from "@ardurbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => {
  const box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: box,
    DialogTitle: box,
    AlertDialog: box,
    AlertDialogAction: (props: ComponentProps<"button">) => <button {...props} />,
    AlertDialogCancel: (props: ComponentProps<"button">) => <button {...props} />,
    AlertDialogContent: box,
    AlertDialogDescription: box,
    AlertDialogFooter: box,
    AlertDialogHeader: box,
    AlertDialogTitle: box,
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
  };
});
vi.mock("./ai/primitives", () => ({
  LoadingState: ({ label }: { label: ReactNode }) => <>{label}</>,
}));

const client = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  dismiss: vi.fn(),
  releaseInterrupted: vi.fn(),
}));
vi.mock("../lib/computer-updates", async () => {
  const { createComputerUpdates } = await import("@ardurbot/core");
  return { computerUpdates: createComputerUpdates(client) };
});

import { computerUpdates } from "../lib/computer-updates";
import { ComputerUpdateProgress } from "./ComputerUpdateProgress";

const base: ComputerUpdate = {
  action: "update",
  id: "update-1",
  botId: "bot",
  name: "Builder",
  mode: "dedicated",
  status: "failed",
  stage: "recreating",
};

afterEach(() => {
  vi.clearAllMocks();
});

async function mounted(update: ComputerUpdate, run: (container: HTMLDivElement) => Promise<void>) {
  client.list.mockResolvedValue([update]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ComputerUpdateProgress onCompleted={() => {}} />));
    await act(async () => {
      computerUpdates.watch();
      await Promise.resolve();
    });
    await act(async () => computerUpdates.open(update.id));
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

it("offers Recover and the generic warning for a failure with no reason", async () => {
  await mounted(base, async (container) => {
    expect(container.textContent).toContain(
      "Recovery restores the last saved workspace. Unsaved work may be lost.",
    );
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent === "Recover computer"),
    ).toBe(true);
  });
});

it("shows the missing-engine sentence instead of the warning, and hides Recover", async () => {
  const sentence =
    "This computer runs on E2B, which is not configured here. Reset it in Settings, Computers " +
    "to start it on this deployment's engine, or configure E2B again.";
  await mounted({ ...base, failureReason: sentence }, async (container) => {
    expect(container.textContent).toContain(sentence);
    expect(container.textContent).not.toContain(
      "Recovery restores the last saved workspace. Unsaved work may be lost.",
    );
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent === "Recover computer"),
    ).toBe(false);
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Dismiss")).toBe(
      true,
    );
  });
});
