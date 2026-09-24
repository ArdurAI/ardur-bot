import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProcessEvent } from "@ardurbot/adapter-kit";
import { ComputerConnectionSettingsSchema } from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KubernetesSandboxProvider } from "./kubernetes-sandbox.js";
import { FakeKubernetesApi } from "./kubernetes-test-api.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
};
const apis: FakeKubernetesApi[] = [];
afterEach(() => {
  for (const api of apis.splice(0)) api.dispose();
});
function fixture() {
  const api = new FakeKubernetesApi();
  apis.push(api);
  return {
    api,
    provider: new KubernetesSandboxProvider(
      api,
      ComputerConnectionSettingsSchema.parse({ engine: "kubernetes" }),
    ),
  };
}
describe("Kubernetes computer", () => {
  it("streams stderr before the remote process exits", async () => {
    const { api, provider } = fixture();
    const computer = await provider.provision({ botId: "stream", homePath: "/unused" }, context);
    vi.spyOn(api, "exec").mockImplementation(async function* () {
      yield { type: "stderr", data: "progress" };
      yield { type: "exit", code: 0 };
    });
    const execution = provider
      .execute(computer, { argv: ["python3", "job.py"] }, context)
      [Symbol.asyncIterator]();
    expect((await execution.next()).value).toEqual({ type: "stderr", data: "progress" });
    await execution.return?.();
  });

  it("waits for PVC deletion before allowing a replacement to reuse its name", async () => {
    const { api, provider } = fixture();
    const computer = await provider.provision({ botId: "replace", homePath: "/unused" }, context);
    const originalRead = api.read.bind(api);
    const originalRemove = api.remove.bind(api);
    let terminating: ReturnType<typeof originalRead> | undefined;
    vi.spyOn(api, "remove").mockImplementation(async (resource, name, signal) => {
      if (resource === "persistentvolumeclaims") terminating = originalRead(resource, name, signal);
      await originalRemove(resource, name, signal);
    });
    let sawTerminating = false;
    vi.spyOn(api, "read").mockImplementation(async (resource, name, signal) => {
      if (resource === "persistentvolumeclaims" && terminating) {
        const previous = await terminating;
        terminating = undefined;
        sawTerminating = true;
        return previous;
      }
      return originalRead(resource, name, signal);
    });
    await provider.destroy(computer, context);
    expect(sawTerminating).toBe(true);
    expect(
      (await provider.provision({ botId: "replace", homePath: "/unused" }, context)).fresh,
    ).toBe(true);
  });
  it("creates, streams exec, sleeps with the PVC intact, wakes and destroys", async () => {
    const { api, provider } = fixture();
    const request = { botId: "bot", homePath: "/unused", imageProfile: "developer" as const };
    const computer = await provider.provision(request, context);
    await provider.prepare(computer, context);
    const events: ProcessEvent[] = [];
    for await (const event of provider.execute(computer, { argv: ["emit"] }, context))
      events.push(event);
    expect(events).toEqual([
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 7 },
    ]);
    await provider.writeFile(
      computer,
      { path: "work/result.txt", content: new TextEncoder().encode("saved") },
      context,
    );
    await provider.stop(computer, context);
    expect([...api.objects.keys()]).toEqual([`persistentvolumeclaims/${computer.id}`]);
    const awake = await provider.provision(request, context);
    await provider.prepare(awake, context);
    expect(awake.fresh).toBe(false);
    expect(
      new TextDecoder().decode(await provider.readFile(awake, "work/result.txt", context)),
    ).toBe("saved");
    await provider.destroy(awake, context);
    await provider.destroy(awake, context);
    expect(api.objects.size).toBe(0);
  });
  it("creates only non-root workloads without credentials or service account tokens", async () => {
    const { api, provider } = fixture();
    await provider.provision(
      { botId: "bot", homePath: "/unused", imageProfile: "developer" },
      context,
    );
    const pod = api.requests.find((request) => request.resource === "pods")!.body!;
    expect(pod.spec).toMatchObject({
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
      containers: [
        {
          image: "ardurbot/computer:0.1.0-developer",
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          resources: {
            requests: { cpu: "250m", memory: "256Mi" },
            limits: { cpu: "2", memory: "2Gi" },
          },
        },
      ],
    });
    expect(JSON.stringify(pod)).not.toMatch(/kubeconfig|credential|hostPath|secretKeyRef|envFrom/i);
    expect(api.requests[0]!.body!.spec).toMatchObject({
      resources: { requests: { storage: "10Gi" } },
    });
    expect(provider.describe().capabilities).toMatchObject({
      graphical: false,
      interactiveTerminal: false,
      persistentHome: true,
    });
    await expect(provider.observe()).rejects.toThrow("Not available on this computer");
  });
  it("transfers files larger than argument limits through stdin and preserves the executable bit", async () => {
    const { provider } = fixture();
    const computer = await provider.provision({ botId: "large", homePath: "/unused" }, context);
    const content = new Uint8Array(200_000).fill(42);
    await provider.writeFile(computer, { path: "bin/tool", content, executable: true }, context);
    expect(await provider.readFile(computer, "bin/tool", context)).toEqual(content);
    await expect(
      provider.readFile(computer, "bin/tool", context, { maxBytes: 10 }),
    ).rejects.toThrow("file operation");
    expect(await provider.listFiles(computer, "bin", context)).toEqual([
      { path: "bin/tool", kind: "file", size: content.byteLength, executable: true },
    ]);
  });
  it("rejects foreign references, path traversal, and symlinks outside the workspace", async () => {
    const { api, provider } = fixture();
    const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, context);
    await expect(provider.stop(computer, { ...context, spaceId: "another" })).rejects.toThrow(
      "workspace",
    );
    await expect(provider.readFile(computer, "../outside", context)).rejects.toThrow("workspace");
    const outside = path.join(api.root, "outside");
    writeFileSync(outside, "private");
    symlinkSync(outside, path.join(api.root, computer.id, "escape"));
    await expect(provider.readFile(computer, "escape", context)).rejects.toThrow("file operation");
    await provider.writeFile(
      computer,
      { path: "escape", content: new TextEncoder().encode("replacement") },
      context,
    );
    expect(new TextDecoder().decode(await provider.readFile(computer, "escape", context))).toBe(
      "replacement",
    );
    api.objects.set(`pods/${computer.id}`, { metadata: { name: computer.id, labels: {} } });
    await expect(provider.destroy(computer, context)).rejects.toThrow("identity");
  });
});
