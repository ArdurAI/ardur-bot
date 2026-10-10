// @vitest-environment jsdom
import type { ComputerStatus, WorkspaceContext } from "@ardurbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
  msg: (parts: TemplateStringsArray) => parts,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
}));

import { ViewControls } from "./ViewControls";

const hostComputer = {
  computerId: "computer",
  kind: "desktop",
  state: "running",
  runsOnHost: true,
  capabilities: { graphical: false, interactiveTerminal: false },
} as ComputerStatus;
const hostContext = {
  botId: "bot",
  computerId: "computer",
  generation: 1,
  files: "live",
  runsOnHost: true,
  observedAt: "2026-10-09T00:00:00.000Z",
} as WorkspaceContext;

async function openMenu({
  computer = hostComputer,
  context = hostContext,
  active = "tasks",
  visible = true,
}: {
  computer?: ComputerStatus;
  context?: WorkspaceContext;
  active?: string;
  visible?: boolean;
} = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <ViewControls
        capabilities={{ computer, context }}
        layout={{ active, position: "right" } as never}
        visible={visible}
        onOpen={() => undefined}
        onPosition={() => undefined}
      >
        {null}
      </ViewControls>,
    ),
  );
  const trigger = host.querySelector("[data-workspace-trigger]") as HTMLButtonElement;
  await act(async () => trigger.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  return {
    async close() {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    },
  };
}

const checkboxItems = () => [...document.querySelectorAll("[role='menuitemcheckbox']")];
const menuItems = () => [...document.querySelectorAll("[role='menuitem']")];

it("names the computer view by what it opens and reports checked state to accessibility", async () => {
  const menu = await openMenu();
  try {
    const labels = checkboxItems().map((item) => item.textContent);
    expect(labels).toEqual(["Tasks", "Files", "Routines", "Computer screen"]);
    expect(checkboxItems().map((item) => item.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
  } finally {
    await menu.close();
  }
});

it("shows Terminal as a disabled item with a reason when this bot's computer cannot run one", async () => {
  const menu = await openMenu();
  try {
    const terminal = menuItems().find((item) => item.textContent?.includes("Terminal"));
    expect(terminal).toBeDefined();
    expect(terminal!.textContent).toContain("Terminal is unavailable on this computer.");
    expect(terminal!.getAttribute("aria-disabled")).toBe("true");
    expect(checkboxItems().some((item) => item.textContent === "Terminal")).toBe(false);
  } finally {
    await menu.close();
  }
});

it("keeps Terminal as a normal view when the computer supports it", async () => {
  const menu = await openMenu({
    computer: {
      ...hostComputer,
      capabilities: { graphical: true, interactiveTerminal: true },
    } as ComputerStatus,
  });
  try {
    const terminal = checkboxItems().find((item) => item.textContent === "Terminal");
    expect(terminal).toBeDefined();
    expect(terminal!.getAttribute("aria-checked")).toBe("false");
    expect(menuItems().some((item) => item.textContent?.includes("Terminal"))).toBe(false);
  } finally {
    await menu.close();
  }
});
