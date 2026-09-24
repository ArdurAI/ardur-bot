import { EventEmitter } from "node:events";
import type { ProcessEvent } from "@ardurbot/adapter-kit";
import { describe, expect, it } from "vitest";
import type { KubernetesExecClient } from "./kubernetes-exec.js";
import { streamKubernetesExec } from "./kubernetes-exec.js";

class Socket extends EventEmitter {
  protocol = "v5.channel.k8s.io";
  closed = false;
  close() {
    this.closed = true;
  }
}
async function events(
  client: KubernetesExecClient,
  signal = new AbortController().signal,
  input?: Uint8Array,
) {
  const result: ProcessEvent[] = [];
  for await (const event of streamKubernetesExec(
    client,
    "namespace",
    "computer",
    ["tool"],
    signal,
    input,
  ))
    result.push(event);
  return result;
}
describe("Kubernetes exec websocket streams", () => {
  it("preserves stdout, stderr, UTF-8 boundaries and the remote exit status", async () => {
    const socket = new Socket();
    const client: KubernetesExecClient = {
      async exec(_ns, _name, _container, _argv, out, err, _in, tty, status) {
        expect(tty).toBe(false);
        setTimeout(() => {
          const bytes = Buffer.from("π");
          out.write(bytes.subarray(0, 1));
          out.write(bytes.subarray(1));
          err.write("failure");
          status({
            status: "Failure",
            details: { causes: [{ reason: "ExitCode", message: "7" }] },
          });
        }, 0);
        return socket;
      },
    };
    expect(await events(client)).toEqual([
      { type: "stdout", data: "π" },
      { type: "stderr", data: "failure" },
      { type: "exit", code: 7 },
    ]);
    expect(socket.closed).toBe(true);
  });
  it("rejects disconnect without a status and redacts transport errors", async () => {
    const socket = new Socket();
    await expect(
      events({
        async exec() {
          setTimeout(() => socket.emit("close"), 0);
          return socket;
        },
      }),
    ).rejects.toThrow("before reporting an exit status");
    await expect(
      events({
        async exec() {
          throw new Error("private-token-and-url");
        },
      }),
    ).rejects.toThrow("transport is unavailable");
  });
  it("bounds an interrupted upgrade and closes a socket that arrives afterwards", async () => {
    const controller = new AbortController();
    const socket = new Socket();
    let connect!: (socket: Socket) => void;
    const work = events(
      {
        exec: async () =>
          new Promise((resolve) => {
            connect = resolve;
          }),
      },
      controller.signal,
    );
    controller.abort();
    await expect(work).rejects.toThrow("interrupted");
    connect(socket);
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.closed).toBe(true);
  });
  it("sends file bytes only through stdin and requires v5 for half-close", async () => {
    const socket = new Socket();
    socket.protocol = "v4.channel.k8s.io";
    await expect(
      events(
        {
          async exec() {
            return socket;
          },
        },
        undefined,
        new Uint8Array([1]),
      ),
    ).rejects.toThrow("protocol v5");
    expect(socket.closed).toBe(true);
  });
});
