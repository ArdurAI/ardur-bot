// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

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

it("keeps the trigger's text to the selected label, with the chevron as a hidden icon", async () => {
  await act(async () =>
    root.render(
      <Select defaultValue="zh-CN" items={{ "zh-CN": "简体中文", en: "English" }}>
        <SelectTrigger data-testid="trigger" aria-label="Language">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="zh-CN">简体中文</SelectItem>
          <SelectItem value="en">English</SelectItem>
        </SelectContent>
      </Select>,
    ),
  );
  const trigger = container.querySelector('[data-testid="trigger"]');
  // A text glyph such as "▼" would leak into the accessible name and into text assertions.
  expect(trigger?.textContent).toBe("简体中文");
  const icon = trigger?.querySelector("svg");
  expect(icon).not.toBeNull();
  expect(icon?.closest('[aria-hidden="true"]')).not.toBeNull();
});
