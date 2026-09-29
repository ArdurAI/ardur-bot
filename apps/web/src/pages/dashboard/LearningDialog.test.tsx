// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-testid="dialog-content" className={className}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../LearningInbox", () => ({
  LearningInbox: () => <div>inbox</div>,
}));

import LearningDialog from "./LearningDialog";

it("keeps learning dialog content inside the dialog width", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<LearningDialog onClose={vi.fn()} />));
  const content = container.querySelector('[data-testid="dialog-content"]');
  const classes = content?.className ?? "";
  expect(classes).toContain("min-w-0");
  expect(classes).toContain("overflow-x-hidden");
  expect(classes).toContain("overflow-y-auto");
  expect(classes).toContain("[&>*]:min-w-0");
  expect(classes).toContain("[&>*]:max-w-full");
  expect(classes.split(/\s+/)).not.toContain("overflow-auto");
  act(() => root.unmount());
});
