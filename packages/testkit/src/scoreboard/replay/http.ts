import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { ReplayFixture, ReplayTiming } from "./protocol.js";
import { REPLAY_SCHEDULES, StrictReplay } from "./protocol.js";

export async function startReplayHttp(
  fixture: ReplayFixture,
  timing: ReplayTiming = "zero-service-delay",
) {
  if (fixture.protocol !== "openai-chat-sse") throw new Error("HTTP replay needs an SSE fixture");
  const replay = new StrictReplay(fixture);
  const schedule = REPLAY_SCHEDULES[timing];
  if (!schedule) throw new Error("Unknown replay timing schedule");
  const errors: unknown[] = [];
  const pending = new Set<Promise<void>>();
  const shutdown = new AbortController();
  const server = createServer((request, response) => {
    const work = (async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1024 * 1024) throw new Error("Replay request exceeds limit");
        chunks.push(Buffer.from(chunk));
      }
      const step = replay.accept({
        method: request.method,
        path: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(step.response.status, step.response.headers);
      for (const [index, chunk] of step.response.chunks.entries()) {
        const ms = index === 0 ? schedule.firstChunkMs : schedule.chunkMs;
        if (ms) await delay(ms, undefined, { signal: shutdown.signal });
        if (response.destroyed) throw new Error("Replay consumer disconnected");
        if (!response.write(chunk))
          await new Promise<void>((resolve, reject) => {
            const drained = () => {
              response.off("close", closed);
              resolve();
            };
            const closed = () => {
              response.off("drain", drained);
              reject(new Error("Replay consumer disconnected"));
            };
            response.once("drain", drained);
            response.once("close", closed);
          });
      }
      if (step.response.end === "disconnect") response.destroy();
      else response.end();
    })().catch((error: unknown) => {
      errors.push(error);
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "Replay request mismatch", type: "fixture_error" } }),
        );
      }
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    replay,
    assertComplete() {
      if (errors.length) throw new AggregateError(errors, "Replay transport failed");
      if (pending.size) throw new Error("Replay response still in flight");
      replay.assertComplete();
    },
    async close() {
      shutdown.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await Promise.allSettled(pending);
    },
  };
}
