import { describe, expect, it, vi } from "vitest";
import { dockerVolumeSizes, parseDockerSize } from "./docker-volumes.js";

describe("parseDockerSize", () => {
  it.each([
    ["0B", 0],
    ["71.52MB", 71_520_000],
    ["1.64GB", 1_640_000_000],
    ["512B", 512],
    ["1kB", 1_000],
  ])("parses %s as %i bytes", (text, expected) => {
    expect(parseDockerSize(text)).toBe(expected);
  });

  it("returns null for text that is not a size", () => {
    expect(parseDockerSize("N/A")).toBeNull();
    expect(parseDockerSize("")).toBeNull();
    expect(parseDockerSize("12 widgets")).toBeNull();
  });
});

function jsonResult(body: unknown, code = 0) {
  return { code, stdout: JSON.stringify(body), stderr: "" };
}

describe("dockerVolumeSizes", () => {
  it("returns bytes only for the requested named volumes", async () => {
    const run = vi.fn(async () =>
      jsonResult({
        Volumes: [
          { Name: "ardurbot-desktop_pgdata", Size: "80.89MB" },
          { Name: "ardurbot-desktop_appdata", Size: "1.2GB" },
          { Name: "some-other-project_pgdata", Size: "500MB" },
        ],
      }),
    );
    const sizes = await dockerVolumeSizes("/usr/bin/docker", {}, "/tmp", run, [
      "ardurbot-desktop_pgdata",
      "ardurbot-desktop_appdata",
    ]);
    expect(sizes).toEqual({
      "ardurbot-desktop_pgdata": 80_890_000,
      "ardurbot-desktop_appdata": 1_200_000_000,
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/docker",
      ["system", "df", "-v", "--format", "json"],
      expect.objectContaining({ cwd: "/tmp" }),
    );
  });

  it("returns null when the daemon does not answer", async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "daemon down" }));
    const sizes = await dockerVolumeSizes("/usr/bin/docker", {}, "/tmp", run, [
      "ardurbot-desktop_pgdata",
    ]);
    expect(sizes).toBeNull();
  });

  it("returns null when the output is not the expected JSON shape", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "not json", stderr: "" }));
    expect(await dockerVolumeSizes("/usr/bin/docker", {}, "/tmp", run, ["x"])).toBeNull();
  });
});
