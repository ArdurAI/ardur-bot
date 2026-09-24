import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProcessEvent } from "@ardurbot/adapter-kit";
import type { KubernetesApi, KubernetesObject } from "./kubernetes-client.js";

/** Offline API double. Runs only the adapter's Python file protocol against a temporary home. */
export class FakeKubernetesApi implements KubernetesApi {
  readonly objects = new Map<string, KubernetesObject>();
  readonly requests: {
    operation: string;
    resource: string;
    name: string;
    body?: KubernetesObject;
  }[] = [];
  readonly root = mkdtempSync(path.join(tmpdir(), "computer-api-test-"));
  read(resource: string, name: string, signal: AbortSignal) {
    signal.throwIfAborted();
    return Promise.resolve(this.objects.get(`${resource}/${name}`) ?? null);
  }
  async create(resource: string, body: KubernetesObject, signal: AbortSignal) {
    signal.throwIfAborted();
    const name = body.metadata!.name!;
    if (this.objects.has(`${resource}/${name}`)) throw new Error("Already exists");
    this.requests.push({ operation: "create", resource, name, body });
    this.objects.set(`${resource}/${name}`, {
      ...body,
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
    });
    if (resource === "persistentvolumeclaims")
      mkdirSync(path.join(this.root, name), { recursive: true });
  }
  async remove(resource: string, name: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.requests.push({ operation: "delete", resource, name });
    this.objects.delete(`${resource}/${name}`);
    if (resource === "persistentvolumeclaims")
      rmSync(path.join(this.root, name), { recursive: true, force: true });
  }
  async *exec(
    name: string,
    argv: string[],
    signal: AbortSignal,
    input?: Uint8Array,
  ): AsyncIterable<ProcessEvent> {
    if (!this.objects.has(`pods/${name}`)) throw new Error("Pod missing");
    signal.throwIfAborted();
    const command = argv[0] === "python3" ? argv : argv.slice(argv.indexOf("ardurbot") + 2);
    const root = path.join(this.root, name);
    if (command[0] === "python3") {
      const script = command[2]!.replaceAll(JSON.stringify("/home/ardurbot"), JSON.stringify(root));
      const child = spawn("python3", ["-c", script, ...command.slice(3)], { signal });
      child.stdin.end(input);
      const events: ProcessEvent[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      child.stdout.on("data", (chunk: Buffer) => {
        events.push({ type: "stdout", data: chunk.toString() });
        wake?.();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        events.push({ type: "stderr", data: chunk.toString() });
        wake?.();
      });
      child.on("close", (code) => {
        events.push({ type: "exit", code: code ?? 1 });
        done = true;
        wake?.();
      });
      child.on("error", () => {
        done = true;
        wake?.();
      });
      while (!done || events.length) {
        if (events.length) yield events.shift()!;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    } else if (command[0] === "echo") {
      yield { type: "stdout", data: `${command.slice(1).join(" ")}\n` };
      yield { type: "exit", code: 0 };
    } else if (command[0] === "emit") {
      yield { type: "stdout", data: "out" };
      yield { type: "stderr", data: "err" };
      yield { type: "exit", code: 7 };
    } else {
      yield { type: "stderr", data: "not installed" };
      yield { type: "exit", code: 127 };
    }
  }
  dispose() {
    rmSync(this.root, { recursive: true, force: true });
  }
}
