// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { renderSettings } from "../test/settings-ui";

const history = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({ rpc: { routines: { history } } }));
vi.mock("../lib/run-status-label", () => ({
  statusLabel: (status: string) => (status === "failed" ? "Failed" : "Done"),
}));

import { RoutineHistory } from "./RoutineHistory";

it("refreshes after a Test run and shows its outcome and timestamp instead of the empty state", async () => {
  history.mockResolvedValueOnce([]).mockResolvedValue([
    {
      id: "attempt",
      status: "failed",
      createdAt: "2026-09-24T12:00:00Z",
      completedAt: "2026-09-24T12:00:01Z",
    },
  ]);
  const { root, container } = await renderSettings(
    <RoutineHistory routineId="routine" running={false} />,
  );
  expect(container.textContent).toContain("No runs yet");
  await act(async () => root.render(<RoutineHistory routineId="routine" running />));
  await act(async () => root.render(<RoutineHistory routineId="routine" running={false} />));
  expect(container.textContent).toContain("Failed");
  expect(container.textContent).not.toContain("No runs yet");
  expect(container.querySelector("time")?.dateTime).toBe("2026-09-24T12:00:01Z");
});
