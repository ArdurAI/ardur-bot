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

it("says waiting for the model only while every listed bot waits to retry", () => {
  expect(
    workingIndicatorLabel([{ name: "Ada", status: "queued", retrying: true }], { room: true }),
  ).toBe("Waiting for the model");
  expect(
    workingIndicatorLabel(
      [
        { name: "Ada", status: "queued", retrying: true },
        { name: "Beck", status: "queued", retrying: true },
      ],
      { room: true },
    ),
  ).toBe("Waiting for the model");
  // Once the run leaves its retry wait the row goes back to working.
  expect(
    workingIndicatorLabel([{ name: "Ada", status: "running", retrying: false }], { room: true }),
  ).toBe("Ada is working");
  // A queued bot that is not waiting out a rate limit still waits for a free place.
  expect(workingIndicatorLabel([{ name: "Ada", status: "queued" }], { room: true })).toBe(
    "Waiting for a free place",
  );
  // Mixed waits read as working, not either waiting phrase.
  expect(
    workingIndicatorLabel(
      [
        { name: "Ada", status: "queued", retrying: true },
        { name: "Beck", status: "queued" },
      ],
      { room: true },
    ),
  ).toBe("Bots are working");
});

it("says waiting for the model in a direct thread only while the run waits", () => {
  expect(
    workingIndicatorLabel([{ name: "Ada", status: "queued", retrying: true }], { room: false }),
  ).toBe("Waiting for the model");
  expect(
    workingIndicatorLabel([{ name: "Ada", status: "running", retrying: false }], { room: false }),
  ).toBe("Ada is working");
});
