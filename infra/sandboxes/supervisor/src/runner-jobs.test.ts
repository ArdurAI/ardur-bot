import { describe, expect, it } from "vitest";
import { runnerJobsRouter } from "./runner-jobs.js";

describe("supervisor runner jobs", () => {
  it("should have a basic test", () => {
    expect(runnerJobsRouter).toBeDefined();
  });
});
