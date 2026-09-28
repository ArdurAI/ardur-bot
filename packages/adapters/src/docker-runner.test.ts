import { describe, expect, it } from "vitest";
import { DockerRunnerProvider } from "./docker-runner.js";

describe("docker runner provider", () => {
  it("should have a basic test", () => {
    const provider = new DockerRunnerProvider("http://localhost:1234");
    expect(provider).toBeDefined();
  });
});
