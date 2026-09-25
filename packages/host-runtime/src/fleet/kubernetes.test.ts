import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import type { AdapterContext } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";
import { HostKubernetesConnection } from "./kubernetes.js";
import { kubernetesComputerSpec } from "./kubernetes-spec.js";
import type { FleetProcess } from "./process.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "operation",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
};
const settings = ComputerConnectionSettingsSchema.parse({
  engine: "kubernetes",
  context: "kind-test",
  namespace: "workloads",
});
const configuration = JSON.stringify({
  clusters: [
    { cluster: { server: "https://127.0.0.1:6443", "certificate-authority-data": "fixture" } },
  ],
  users: [{ user: { token: "fixture-token" } }],
});
const name = `ardurbot-${createHash("sha256").update("space\0home").digest("hex").slice(0, 32)}`;
it("runs the exact saved context from the host, confines resources, and cleans credential files", async () => {
  let temporary = "";
  const run = vi.fn(async (_name: string, argv: string[]) => {
    temporary = argv[argv.indexOf("--kubeconfig") + 1]!;
    expect(await readFile(temporary, "utf8")).toBe(configuration);
    expect((await stat(temporary)).mode & 0o777).toBe(0o600);
    return {
      code: 0,
      stdout: Buffer.from(
        argv.includes("version") ? '{"serverVersion":{"gitVersion":"test-version"}}' : "",
      ),
      stderr: Buffer.alloc(0),
    };
  });
  const host = new HostKubernetesConnection(settings, async () => configuration, {
    run,
    start: vi.fn(),
  } as FleetProcess);
  const send = vi.fn();
  await host.call("home", { type: "kube.version" }, context, send);
  expect(send).toHaveBeenCalledWith("result", "test-version");
  expect(run.mock.calls[0]?.[1]).toEqual(
    expect.arrayContaining(["--context", "kind-test", "--namespace", "workloads"]),
  );
  await expect(access(temporary)).rejects.toThrow();
  await expect(
    host.call("home", { type: "kube.remove", resource: "pods", name: "unowned" }, context, send),
  ).rejects.toThrow("belong");
  const body = kubernetesComputerSpec(name, "base", settings);
  await host.call("home", { type: "kube.create", resource: "pods", body }, context, send);
  expect(run.mock.calls.some(([, argv]) => argv.includes("create"))).toBe(true);
  const mutated = structuredClone(body);
  (mutated.spec as Record<string, unknown>).hostNetwork = true;
  await expect(
    host.call("home", { type: "kube.create", resource: "pods", body: mutated }, context, send),
  ).rejects.toThrow("Invalid computer resource");
  expect(JSON.stringify(run.mock.calls)).not.toContain("fixture-token");
});
it("refuses kubeconfig credential plugins before starting any host process", async () => {
  const run = vi.fn();
  const bad = JSON.parse(configuration);
  bad.users[0].user = { exec: { command: "arbitrary" } };
  const host = new HostKubernetesConnection(settings, async () => JSON.stringify(bad), {
    run,
    start: vi.fn(),
  } as FleetProcess);
  await expect(host.call("home", { type: "kube.version" }, context, vi.fn())).rejects.toThrow(
    "kubeconfig",
  );
  expect(run).not.toHaveBeenCalled();
});
