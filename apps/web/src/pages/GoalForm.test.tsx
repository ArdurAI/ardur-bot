// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@ardurbot/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

import { StartGoalForm } from "./GoalForm";

afterEach(() => {
  document.body.innerHTML = "";
});

it("opens the goal form with the owner controls and a bounded default", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(<StartGoalForm groupId="group" onStart={vi.fn()} />));
  expect(element.textContent).toContain("Start goal");
  expect(element.textContent).toContain("Objective");
  expect(element.textContent).toContain("Done when (one per line)");
  expect(element.textContent).toContain("Until (defaults to eight hours)");
  expect(element.textContent).toContain("Token limit");
  expect(element.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("600000");
  expect(element.querySelector("button")?.disabled).toBe(true);
  await act(async () => root.unmount());
});
