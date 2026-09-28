// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AvatarStudioPopover } from "./avatar-studio-popover";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});

async function openStudio(value: string, onChange = vi.fn(), label = "Maya") {
  await act(async () =>
    root.render(
      <AvatarStudioPopover
        value={value}
        identity="clzi2x8n00000l0"
        label={label}
        onChange={onChange}
      />,
    ),
  );
  await act(async () =>
    node.querySelector<HTMLButtonElement>('[data-testid="avatar-studio-trigger"]')!.click(),
  );
  return onChange;
}

function studioButton(name: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name,
  );
  if (!button) throw new Error(`No studio button named ${name}`);
  return button;
}

/** Shape picker buttons in grid order: Seal first, then shapes 0-7. */
function shapeButtons(): HTMLButtonElement[] {
  const tab = document.body.querySelector('[data-testid="avatar-studio-bot-tab"]');
  if (!tab) throw new Error("Bot tab not rendered");
  return [...tab.querySelectorAll<HTMLButtonElement>("div:first-child button")];
}

it("marks the seal — not shape 0 — for a plain color avatar", async () => {
  await openStudio("#2F4A7A");
  const shapes = shapeButtons();
  expect(shapes).toHaveLength(9);
  expect(shapes.map((button) => button.getAttribute("aria-pressed"))).toEqual([
    "true",
    ...Array(8).fill("false"),
  ]);
});

it("marks the nearest pigment for a legacy stored color", async () => {
  await openStudio("#EAB308");
  expect(studioButton("Color #A84A22").getAttribute("aria-pressed")).toBe("true");
});

it("keeps a seal a seal when only the color changes", async () => {
  const onChange = await openStudio("#2F4A7A");
  await act(async () => studioButton("Color #7F621B").click());
  expect(onChange).toHaveBeenCalledWith("#7F621B");
});

it("marks the encoded shape and keeps it when the color changes", async () => {
  const onChange = await openStudio("#2F4A7A::shape_3");
  const shapes = shapeButtons();
  expect(shapes[4]?.getAttribute("aria-pressed")).toBe("true");
  expect(shapes[0]?.getAttribute("aria-pressed")).toBe("false");
  await act(async () => studioButton("Color #7F621B").click());
  expect(onChange).toHaveBeenCalledWith("#7F621B::shape_3");
});

it("renders the bot name initial, not the id initial, on the seal", async () => {
  await openStudio("#2F4A7A");
  const trigger = node.querySelector<HTMLButtonElement>('[data-testid="avatar-studio-trigger"]')!;
  expect(trigger.textContent).toContain("M");
  expect(trigger.textContent).not.toContain("C");
  expect(studioButton("Seal").textContent).toContain("M");
});
