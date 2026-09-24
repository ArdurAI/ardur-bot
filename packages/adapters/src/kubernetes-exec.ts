import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { ProcessEvent } from "@ardurbot/adapter-kit";

export interface KubernetesExecStatus {
  status?: string;
  details?: { causes?: { reason?: string; message?: string }[] };
}
export interface KubernetesExecSocket {
  protocol: string;
  close(): void;
  on(event: "error" | "close", listener: () => void): unknown;
}
export interface KubernetesExecClient {
  exec(
    namespace: string,
    name: string,
    container: string,
    argv: string[],
    stdout: Writable,
    stderr: Writable,
    stdin: Readable | null,
    tty: boolean,
    status: (status: KubernetesExecStatus) => void,
  ): Promise<KubernetesExecSocket>;
}

export async function* streamKubernetesExec(
  client: KubernetesExecClient,
  namespace: string,
  name: string,
  argv: string[],
  signal: AbortSignal,
  input?: Uint8Array,
): AsyncIterable<ProcessEvent> {
  signal.throwIfAborted();
  const queue: ProcessEvent[] = [];
  let buffered = 0;
  let wake: (() => void) | undefined;
  let done = false;
  let gotStatus = false;
  let failure: Error | undefined;
  let socket: KubernetesExecSocket | undefined;
  const push = (event: ProcessEvent) => {
    if (event.type !== "exit") buffered += Buffer.byteLength(event.data);
    if (buffered > 32 * 1024 * 1024) {
      failure = new Error("Kubernetes command output exceeds the buffer limit.");
      done = true;
      socket?.close();
    } else queue.push(event);
    wake?.();
  };
  const output = (type: "stdout" | "stderr") => {
    const decoder = new StringDecoder("utf8");
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const data = decoder.write(chunk);
        if (data) push({ type, data });
        callback();
      },
      final(callback) {
        const data = decoder.end();
        if (data) push({ type, data });
        callback();
      },
    });
  };
  const stdout = output("stdout");
  const stderr = output("stderr");
  const stdin = input ? new Readable({ read() {} }) : null;
  const abort = () => {
    done = true;
    socket?.close();
    wake?.();
  };
  signal.addEventListener("abort", abort, { once: true });
  const opening = client
    .exec(namespace, name, "computer", argv, stdout, stderr, stdin, false, (status) => {
      stdout.end();
      stderr.end();
      const code =
        status.status === "Success"
          ? 0
          : Number(
              status.details?.causes?.find((cause) => cause.reason === "ExitCode")?.message ?? 1,
            );
      gotStatus = true;
      push({ type: "exit", code: Number.isInteger(code) ? code : 1 });
      done = true;
      wake?.();
    })
    .then((connected) => {
      socket = connected;
      if (signal.aborted || failure) connected.close();
      return connected;
    });
  // A hung upgrade cannot hold a run lease indefinitely. Close a late socket as it arrives.
  let rejectOpening: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectOpening = () => reject(new Error("Command interrupted."));
    signal.addEventListener("abort", rejectOpening, { once: true });
  });
  if (signal.aborted) rejectOpening?.();
  try {
    try {
      socket = await Promise.race([opening, interrupted]);
    } catch {
      throw new Error("Kubernetes command transport is unavailable or interrupted.");
    }
    socket.on("error", abort);
    socket.on("close", () => {
      done = true;
      wake?.();
    });
    if (stdin) {
      // v5 half-closes stdin without closing stdout/status; older protocols cannot do this.
      if (socket.protocol !== "v5.channel.k8s.io")
        throw new Error(
          "File transfer requires Kubernetes exec protocol v5 (Kubernetes 1.31 or later).",
        );
      stdin.push(input);
      stdin.push(null);
    }
    while (!done || queue.length) {
      if (queue.length) {
        const event = queue.shift()!;
        if (event.type !== "exit") buffered -= Buffer.byteLength(event.data);
        yield event;
      } else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    if (failure) throw failure;
    if (!gotStatus)
      throw new Error(
        signal.aborted
          ? "Kubernetes command interrupted; its outcome is uncertain."
          : "Kubernetes command disconnected before reporting an exit status.",
      );
  } finally {
    signal.removeEventListener("abort", abort);
    if (rejectOpening) signal.removeEventListener("abort", rejectOpening);
    stdin?.destroy();
    stdout.destroy();
    stderr.destroy();
    socket?.close();
  }
}
