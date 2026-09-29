import { expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => text + (index > 0 ? String(values[index - 1]) : "") + part,
      "",
    ),
}));

import { workingIndicatorLabel } from "./working-indicator";

it("says a room bot is waiting for a free place only while its run is queued", () => {
  expect(workingIndicatorLabel([{ name: "Ada", status: "queued" }], { room: true })).toBe(
    "Waiting for a free place",
  );
  expect(
    workingIndicatorLabel(
      [
        { name: "Ada", status: "queued" },
        { name: "Beck", status: "queued" },
      ],
      { room: true },
    ),
  ).toBe("Waiting for a free place");
  expect(workingIndicatorLabel([{ name: "Ada", status: "running" }], { room: true })).toBe(
    "Ada is working",
  );
  expect(
    workingIndicatorLabel(
      [
        { name: "Ada", status: "running" },
        { name: "Beck", status: "queued" },
      ],
      { room: true },
    ),
  ).toBe("Bots are working");
});

it("keeps a direct thread's queued run as working, never a room phrase", () => {
  expect(workingIndicatorLabel([{ name: "Ada", status: "queued" }], { room: false })).toBe(
    "Ada is working",
  );
});
