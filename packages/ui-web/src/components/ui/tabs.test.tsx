// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
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
function mount() {
  return act(async () =>
    root.render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">First</TabsContent>
        <TabsContent value="two">Second</TabsContent>
      </Tabs>,
    ),
  );
}

it("marks the active default-variant tab with the ink underline indicator", async () => {
  await mount();
  const list = container.querySelector('[data-slot="tabs-list"]')!;
  expect(list.className).toContain("bg-secondary");
  const triggers = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="tabs-trigger"]')];
  expect(triggers).toHaveLength(2);
  const active = triggers.find((trigger) => trigger.textContent === "One")!;
  const inactive = triggers.find((trigger) => trigger.textContent === "Two")!;
  expect(active.hasAttribute("data-active")).toBe(true);
  expect(inactive.hasAttribute("data-active")).toBe(false);
  // The ink underline is the selection indicator that clears 3:1 on the track.
  expect(active.className).toContain("data-active:after:opacity-100");
  expect(active.className).toContain("after:bg-foreground");
});

it("moves the indicator and data-active to the newly selected tab", async () => {
  await mount();
  const inactive = [
    ...container.querySelectorAll<HTMLButtonElement>('[data-slot="tabs-trigger"]'),
  ].find((trigger) => trigger.textContent === "Two")!;
  await act(async () => inactive.click());
  expect(inactive.hasAttribute("data-active")).toBe(true);
  const panel = container.querySelector('[role="tabpanel"]');
  expect(panel?.textContent).toBe("Second");
});
