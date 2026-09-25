import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ReplayFixture } from "./protocol.js";
import { StrictReplay } from "./protocol.js";

/** Protocol/process boundary only. This never launches or authenticates an installed native CLI. */
export function replayNativeProcess(fixture: ReplayFixture) {
  if (fixture.protocol === "openai-chat-sse") throw new Error("Expected native protocol fixture");
  const replay = new StrictReplay(fixture);
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = "";
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stdout.end();
    stderr.end();
    Object.assign(child, { exitCode: 0 });
    child.emit("close", 0);
  };
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      try {
        input += String(chunk);
        if (Buffer.byteLength(input) > 8 * 1024 * 1024)
          throw new Error("Native replay request exceeds limit");
        let boundary = input.indexOf("\n");
        while (boundary >= 0) {
          const line = input.slice(0, boundary);
          input = input.slice(boundary + 1);
          if (!line.trim()) throw new Error("Empty native replay request");
          const exchange = replay.accept(JSON.parse(line));
          queueMicrotask(() => {
            for (const output of exchange.response.chunks) stdout.write(output);
            if (exchange.response.end === "disconnect") close();
          });
          boundary = input.indexOf("\n");
        }
        done();
      } catch (error) {
        done();
        queueMicrotask(() => {
          child.emit("error", error);
          close();
        });
      }
    },
  });
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: () => {
      close();
      return true;
    },
  });
  return {
    child,
    replay,
    close,
    assertComplete() {
      if (input.length) throw new Error("Partial native request");
      replay.assertComplete();
    },
  };
}
