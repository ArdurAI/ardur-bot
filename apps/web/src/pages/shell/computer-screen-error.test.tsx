// @vitest-environment jsdom
import { COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE } from "@ardurbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

import { ComputerScreenError } from "./computer-screen-error";

const containers: HTMLDivElement[] = [];
afterEach(() => {
  for (const container of containers) container.remove();
  containers.length = 0;
});

it.each([
  [COMPUTER_IMAGE_DOWNLOAD_FAILED_CODE, "Try again", "provision"],
  [undefined, "Retry screen", "screen"],
] as const)("routes %s retry to %s", async (code, label, target) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  const provision = vi.fn();
  const screen = vi.fn();
  await act(async () => {
    root.render(
      <ComputerScreenError
        message="Computer image unavailable"
        code={code}
        onRetryProvision={provision}
        onRetryScreen={screen}
      />,
    );
  });
  const button = container.querySelector("button");
  expect(button?.textContent).toBe(label);
  await act(async () => button?.click());
  expect(provision).toHaveBeenCalledTimes(target === "provision" ? 1 : 0);
  expect(screen).toHaveBeenCalledTimes(target === "screen" ? 1 : 0);
  await act(async () => root.unmount());
});
