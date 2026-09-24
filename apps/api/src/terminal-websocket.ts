import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { TERMINAL_FRAME_BYTES, TERMINAL_HEADER_BYTES } from "@ardurbot/contracts";
import type { TerminalGateway, TerminalSocket } from "./terminal-gateway.js";

const MAX_MESSAGE = TERMINAL_FRAME_BYTES + TERMINAL_HEADER_BYTES;
/** A bounded RFC 6455 receiver. No compression or extensions are negotiated. */
export class TerminalWebSocket implements TerminalSocket {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private opcode = 0;
  private ended = false;
  private busy = false;
  constructor(
    private readonly socket: Duplex,
    private readonly receive: (data: string | Uint8Array) => Promise<void>,
    private readonly detached: () => void,
  ) {
    socket.on("data", (chunk) => this.feed(Buffer.from(chunk)));
    socket.on("error", () => this.close());
    socket.on("close", () => this.finish());
  }
  feed(chunk: Buffer) {
    if (this.ended) return;
    if (this.buffer.length + chunk.length > MAX_MESSAGE * 4) return this.close();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    void this.read();
  }
  private async read() {
    if (this.busy) return;
    this.busy = true;
    this.socket.pause();
    try {
      while (!this.ended && this.buffer.length >= 2) {
        const first = this.buffer[0]!,
          second = this.buffer[1]!,
          opcode = first & 15,
          fin = Boolean(first & 128);
        if (first & 112 || !(second & 128) || ![0, 1, 2, 8, 9, 10].includes(opcode))
          throw new Error("Invalid frame.");
        let size = second & 127,
          offset = 2;
        if (size === 126) {
          if (this.buffer.length < 4) break;
          size = this.buffer.readUInt16BE(2);
          offset = 4;
          if (size < 126) throw new Error("Invalid length.");
        } else if (size === 127) {
          if (this.buffer.length < 10) break;
          const wide = this.buffer.readBigUInt64BE(2);
          if (wide < 65536 || wide > BigInt(MAX_MESSAGE)) throw new Error("Invalid length.");
          size = Number(wide);
          offset = 10;
        }
        if (size > MAX_MESSAGE || (opcode >= 8 && (!fin || size > 125)))
          throw new Error("Frame too large.");
        if (this.buffer.length < offset + 4 + size) break;
        const mask = this.buffer.subarray(offset, offset + 4),
          body = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + size));
        this.buffer = this.buffer.subarray(offset + 4 + size);
        for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ mask[i % 4]!;
        if (opcode === 8) {
          this.close();
          break;
        }
        if (opcode === 9) {
          await this.frame(10, body);
          continue;
        }
        if (opcode === 10) continue;
        if (opcode === 0 ? !this.opcode : this.opcode !== 0)
          throw new Error("Invalid continuation.");
        if (opcode) this.opcode = opcode;
        this.fragmentBytes += size;
        if (this.fragmentBytes > (this.opcode === 1 ? 512 : MAX_MESSAGE))
          throw new Error("Message too large.");
        this.fragments.push(body);
        if (fin) {
          const payload = Buffer.concat(this.fragments),
            type = this.opcode;
          this.fragments = [];
          this.fragmentBytes = 0;
          this.opcode = 0;
          await this.receive(
            type === 1 ? new TextDecoder("utf-8", { fatal: true }).decode(payload) : payload,
          );
        }
      }
    } catch {
      this.close();
    } finally {
      this.busy = false;
      if (!this.ended) this.socket.resume();
    }
  }
  private frame(opcode: number, body: Uint8Array) {
    if (this.ended) return Promise.reject(new Error("Socket closed."));
    const head = Buffer.alloc(body.length < 126 ? 2 : body.length <= 65535 ? 4 : 10);
    head[0] = 128 | opcode;
    if (head.length === 2) head[1] = body.length;
    else if (head.length === 4) {
      head[1] = 126;
      head.writeUInt16BE(body.length, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(body.length), 2);
    }
    return new Promise<void>((resolve, reject) =>
      this.socket.write(Buffer.concat([head, body]), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  send(data: string | Uint8Array) {
    return this.frame(
      typeof data === "string" ? 1 : 2,
      typeof data === "string" ? Buffer.from(data) : data,
    );
  }
  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.detached();
  }
  close() {
    this.finish();
    this.socket.destroy();
  }
}

type Server = {
  on(
    event: "upgrade",
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
};
export function installTerminalWebSocket(
  server: Server,
  gateway: TerminalGateway | undefined,
  trustedOrigin: (origin: string) => boolean,
) {
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/terminal/socket") return;
    const origin = request.headers.origin,
      key = request.headers["sec-websocket-key"];
    if (
      !gateway ||
      request.method !== "GET" ||
      !origin ||
      !trustedOrigin(origin) ||
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      !request.headers.connection
        ?.toLowerCase()
        .split(/\s*,\s*/)
        .includes("upgrade") ||
      request.headers["sec-websocket-version"] !== "13" ||
      typeof key !== "string" ||
      !/^[a-zA-Z0-9+/]{22}==$/.test(key)
    ) {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let disconnected = false;
    let attachment: Awaited<ReturnType<TerminalGateway["attach"]>> | undefined;
    const timer = setTimeout(() => transport.close(), 5_000);
    timer.unref?.();
    const transport = new TerminalWebSocket(
      socket,
      async (data) => {
        if (attachment) return attachment.receive(data);
        if (typeof data !== "string" || data.length > 512)
          throw new Error("Authentication required.");
        const value = JSON.parse(data);
        if (
          value.type !== "connect" ||
          typeof value.ticket !== "string" ||
          value.ticket.length !== 43
        )
          throw new Error("Authentication required.");
        attachment = await gateway.attach(value.ticket, origin, value.ack, transport);
        clearTimeout(timer);
        if (disconnected) attachment.detach();
      },
      () => {
        clearTimeout(timer);
        disconnected = true;
        attachment?.detach();
      },
    );
    if (head.length) transport.feed(head);
  });
}
