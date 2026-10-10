import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { deviceProxy } from "./remote-listener.js";

it("delivers an SSE frame over loopback before the upstream response finishes", async () => {
  let finish!: () => void;
  const release = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let upstreamFinished = false;
  const upstream = createServer(async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": heartbeat\n\n");
    await release;
    upstreamFinished = true;
    response.end('event: window\ndata: {"nextCursor":-1,"reason":"timeout"}\n\n');
  });
  let proxy: ReturnType<typeof createServer> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Expected fixture TCP address");
    proxy = createServer(deviceProxy(`http://127.0.0.1:${address.port}`));
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string")
      throw new Error("Expected fixture TCP address");
    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/device/request`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
    expect(upstreamFinished).toBe(false);
    finish();
    let rest = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      rest += new TextDecoder().decode(part.value);
    }
    expect(rest).toContain('"nextCursor":-1');
    expect(upstreamFinished).toBe(true);
  } finally {
    finish();
    await reader?.cancel().catch(() => undefined);
    for (const server of [proxy, upstream]) {
      if (!server) continue;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
