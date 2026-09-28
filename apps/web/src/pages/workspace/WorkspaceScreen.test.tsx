// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceScreen } from "./WorkspaceScreen";

const translate = (strings: TemplateStringsArray, ...values: any[]) => {
  return strings.reduce((acc, str, i) => acc + str + (values[i] || ""), "");
};
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: translate,
  }),
}));

it("shows the open button when a status is present but no error", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <WorkspaceScreen
        computer={{ state: "suspended" } as any}
        open={false}
        url={null}
        error={null}
        status="Computer is asleep. Open it to wake."
        onOpen={() => {}}
      />
    );
  });
  
  expect(container.textContent).toContain("Computer is asleep. Open it to wake.");
  expect(container.querySelector('[data-testid="computer-preview-open"]')).not.toBeNull();
  
  root.unmount();
  container.remove();
});

it("hides the open button when an error is present", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <WorkspaceScreen
        computer={{ state: "running" } as any}
        open={false}
        url={null}
        error="Network error"
        onOpen={() => {}}
      />
    );
  });
  
  expect(container.textContent).toContain("Network error");
  expect(container.querySelector('[data-testid="computer-preview-open"]')).toBeNull();
  
  root.unmount();
  container.remove();
});
