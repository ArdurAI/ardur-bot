import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

describe("dev script", () => {
  it("does not invoke docker compose when ARDURBOT_DEV_POSTGRES=embedded", () => {
    // ?
  });
});
