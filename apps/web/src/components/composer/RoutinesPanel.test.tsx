// @vitest-environment jsdom
import type { Routine } from "@ardurbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../pages/RoutineEditor", () => ({
  RoutineListHeader: ({ onCreate }: { onCreate: () => void }) => (
    <button type="button" aria-label="Create Routine" onClick={onCreate}>
      +
    </button>
  ),
  RoutineListRow: ({ routine }: { routine: Routine }) => <div>{routine.name}</div>,
}));

import RoutinesPanel from "./RoutinesPanel";

async function mounted(routines: readonly Routine[], run: (container: HTMLDivElement) => void) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <RoutinesPanel
          routines={routines}
          onCreate={() => undefined}
          onOpen={() => undefined}
          onStop={() => undefined}
        />,
      ),
    );
    run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
}

it("shows one plain sentence and only the Create Routine action when there are no routines", async () => {
  await mounted([], (container) => {
    expect(container.textContent).toContain(
      "No routines yet; a routine runs this bot on a schedule or when an event arrives.",
    );
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Create Routine");
  });
});

it("hides the empty sentence once a routine exists", async () => {
  await mounted([{ id: "routine-1", name: "Morning checklist" } as Routine], (container) => {
    expect(container.textContent).not.toContain("No routines yet");
    expect(container.textContent).toContain("Morning checklist");
  });
});
