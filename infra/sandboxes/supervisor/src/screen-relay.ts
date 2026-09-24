import net from "node:net";
import { Writable } from "node:stream";
import type Docker from "dockerode";
import { withKeyedLock } from "./supervisor-logic.js";

// Only the inspected container's local screen port is reachable through this transport.
export const SCREEN_RELAY_SCRIPT = `import os, selectors, socket, sys
s = socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=10)
s.settimeout(None)
sel = selectors.DefaultSelector()
sel.register(0, selectors.EVENT_READ)
sel.register(s, selectors.EVENT_READ)
try:
  while True:
    for key, _ in sel.select():
      if key.fileobj == 0:
        data = os.read(0, 65536)
        if not data: sys.exit(0)
        s.sendall(data)
      else:
        data = s.recv(65536)
        if not data: sys.exit(0)
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
finally:
  s.close()
`;

const relays = new Map<string, { server: net.Server; port: number }>();
const relayLocks = new Map<string, Promise<unknown>>();
export async function screenRelay(container: Docker.Container, port: number, host: string) {
  if (!Number.isInteger(port) || port < 6080 || port > 6095) throw new Error("Invalid screen port");
  const key = `${container.id}:${port}:${host}`;
  return withKeyedLock(relayLocks, key, () => createRelay(container, port, host, key));
}
async function createRelay(container: Docker.Container, port: number, host: string, key: string) {
  const existing = relays.get(key);
  if (existing) return existing.port;
  const server = net.createServer(async (socket) => {
    socket.on("error", () => socket.destroy());
    try {
      const exec = await container.exec({
        Cmd: ["python3", "-u", "-c", SCREEN_RELAY_SCRIPT, String(port)],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
      const stream = await exec.start({ hijack: true, stdin: true });
      if (socket.destroyed) {
        stream.destroy();
        return;
      }
      socket.pipe(stream);
      container.modem.demuxStream(
        stream,
        socket,
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      );
      socket.once("close", () => stream.destroy());
      stream.once("end", () => socket.end());
      stream.once("error", () => socket.destroy());
    } catch {
      socket.destroy();
    }
  });
  server.maxConnections = 32;
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Screen relay unavailable");
  relays.set(key, { server, port: address.port });
  const cleanup = setInterval(() => {
    server.getConnections((error, count) => {
      if (!error && count === 0) {
        server.close();
        relays.delete(key);
        clearInterval(cleanup);
      }
    });
  }, 300_000);
  cleanup.unref();
  return address.port;
}
