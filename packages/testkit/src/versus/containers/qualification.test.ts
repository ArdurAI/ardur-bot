import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { sanitize } from "../provenance.js";
import { qualifyContainers } from "./qualification.js";

const inspectImage = vi.hoisted(() => vi.fn());
vi.mock("./session.js", () => ({ inspectImage }));
vi.mock("./command-probe.js", () => ({ probeCommandAdmission: vi.fn() }));
vi.mock("../provenance.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  inspectBuild: async () => ({ build: { commit: "synthetic-build", dirty: false } }),
}));

it("retains path-free container startup failures without invoking Docker or reading Git history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "versus-redaction-test-"));
  const paths = ["/mnt/synthetic-runtime/docker.sock", "/tmp/synthetic-policy/seccomp.json"];
  inspectImage.mockRejectedValue(new Error(`connect unix://${paths[0]}; open '${paths[1]}'`));
  try {
    const result = await qualifyContainers(root, true);
    expect(result.status).toBe("blocked");
    expect(result.checks).toHaveLength(0);
    expect(result.realModelCalls).toBe(0);
    const retained = await readFile(path.join(root, "container-qualification.json"), "utf8");
    for (const value of paths) expect(retained).not.toContain(value);
    expect(result.failures[0]).toContain("connect");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("redacts diagnostic paths while retaining HTTP routes and immutable image identities", () => {
  const message = `open "/mnt/Synthetic Disk/profile.json"; stat /tmp/synthetic-file; file:///opt/runtime/bin/node`;
  expect(sanitize(message)).not.toMatch(/\/mnt\/|\/tmp\/|\/opt\/runtime/);
  const publicIdentity = "http://127.0.0.1:11434/api/version nousresearch/hermes-agent@sha256:abc";
  expect(sanitize(publicIdentity)).toBe(publicIdentity);
});

it("preserves serialized evidence when redacted paths have escaped closing quotes", () => {
  const report = {
    diagnostic: 'open "/mnt/Synthetic Disk/profile.json"; file:///tmp/synthetic-file',
    socket: "unix:///mnt/synthetic-runtime/docker.sock",
    origin: "http://127.0.0.1:11434/api/version",
  };
  const sanitized = sanitize(JSON.stringify(report));
  expect(() => JSON.parse(sanitized)).not.toThrow();
  expect(JSON.parse(sanitized).origin).toBe(report.origin);
  expect(sanitized).not.toMatch(/\/mnt\/|\/tmp\//);
});
