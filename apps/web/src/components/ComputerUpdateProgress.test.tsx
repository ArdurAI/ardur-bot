// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const skippedReason = "The computer changed before the move, so it stayed where it is.";
const api = vi.hoisted(() => ({
  updates: vi.fn(async () => [
    {
      id: "move",
      botId: "bot",
      name: "Writer",
      mode: "dedicated" as const,
      action: "update" as const,
      status: "skipped" as const,
      stage: "preparing" as const,
      reason: skippedReason,
    },
  ]),
  dismiss: vi.fn(async () => ({})),
  release: vi.fn(async () => ({})),
  call: vi.fn(async () => ({})),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    computer: {
      updates: api.updates,
      dismissUpdate: api.dismiss,
      releaseInterrupted: api.release,
      update: api.call,
      recover: api.call,
    },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Button = (props: ComponentProps<"button">) => <button {...props} />;
  return {
    Button,
    cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(" "),
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Container,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    AlertDialog: () => null,
    AlertDialogContent: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogCancel: Button,
    AlertDialogAction: Button,
  };
});
vi.mock("lucide-react", () => ({
  CheckCircle2: () => null,
  Circle: () => null,
  CircleAlert: () => null,
  LoaderCircle: () => null,
}));

import { ComputerUpdateProgress } from "./ComputerUpdateProgress";

afterEach(() => {
  document.body.innerHTML = "";
});

it("shows a skipped move as one line and does not offer recovery", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => {
    root.render(<ComputerUpdateProgress onCompleted={() => undefined} />);
    await Promise.resolve();
  });
  const open = [...element.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(skippedReason),
  );
  expect(open).toBeTruthy();
  await act(async () => open!.click());
  const dialog = element.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain(skippedReason);
  expect(dialog?.textContent).not.toContain("Update failed");
  expect(dialog?.textContent).not.toContain("Recovery restores the last saved workspace");
  expect(dialog?.textContent).not.toContain("Recover computer");
  expect([...element.querySelectorAll("button")].map((button) => button.textContent)).not.toContain(
    "Recover computer",
  );
  await act(async () => root.unmount());
});
