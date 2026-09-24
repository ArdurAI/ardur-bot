import type {
  AdapterContext,
  ComputerRef,
  TerminalContext,
  TerminalProvider,
} from "@ardurbot/adapter-kit";
import {
  decodeTerminalFrame,
  TERMINAL_FRAME_BYTES,
  validateTerminalSize,
} from "@ardurbot/contracts";

export class DockerTerminal implements TerminalProvider {
  private sessions = new Map<string, { computer: ComputerRef; context: TerminalContext }>();
  constructor(
    private readonly base: string,
    private readonly headers: (context: AdapterContext, botId?: string) => Record<string, string>,
  ) {}
  private async request(
    computer: ComputerRef,
    context: AdapterContext,
    path: string,
    body?: unknown,
    binary?: Uint8Array,
  ) {
    const response = await fetch(
      `${this.base.replace(/\/$/, "")}/computers/${encodeURIComponent(computer.providerRef)}/terminal${path}`,
      {
        method: "POST",
        headers: {
          ...this.headers(context, computer.botId),
          "content-type": binary ? "application/octet-stream" : "application/json",
        },
        body: binary ? Buffer.from(binary) : JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(path.endsWith("/read") ? 24 * 60 * 60_000 : 35_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Terminal session is unavailable.");
    }
    return response;
  }
  async open(
    computer: ComputerRef,
    options: { cols: number; rows: number; shellProfileId: string },
    context: TerminalContext,
  ) {
    if (computer.kind !== "docker") throw new Error("Terminal is not available on this computer.");
    validateTerminalSize(options.cols, options.rows);
    const response = await this.request(computer, context, "/open", {
      ...options,
      leaseId: context.leaseId,
      fence: context.fence,
      generation: context.generation,
      expiresAt: context.expiresAt,
      workingRoot: context.workingRoot,
    });
    const session = (await response.json()) as { id: string; generation: string };
    this.sessions.set(session.id, { computer, context });
    return session;
  }
  private current(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("Session ended — open a new terminal.");
    return s;
  }
  async write(id: string, bytes: Uint8Array) {
    if (!bytes.length || bytes.length > TERMINAL_FRAME_BYTES)
      throw new Error("Invalid terminal input.");
    const s = this.current(id);
    await this.request(s.computer, s.context, `/${id}/write`, undefined, bytes);
  }
  async resize(id: string, cols: number, rows: number) {
    validateTerminalSize(cols, rows);
    const s = this.current(id);
    await this.request(s.computer, s.context, `/${id}/resize`, { cols, rows });
  }
  async close(id: string, _reason: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    await this.request(s.computer, s.context, `/${id}/close`);
    this.sessions.delete(id);
  }
  async *output(id: string) {
    const s = this.current(id);
    while (this.sessions.has(id)) {
      const response = await this.request(s.computer, s.context, `/${id}/read`);
      if (response.status === 204) return;
      const data = await readTerminalBytes(response);
      yield decodeTerminalFrame(data);
    }
  }
  async revoke(computer: ComputerRef, leaseId: string, context: AdapterContext) {
    if (computer.kind !== "docker") return;
    await this.request(computer, context, "/revoke", { leaseId });
    for (const [id, s] of this.sessions)
      if (s.computer.id === computer.id && s.context.leaseId === leaseId) this.sessions.delete(id);
  }
}

async function readTerminalBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Terminal output is missing.");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > TERMINAL_FRAME_BYTES + 9) {
        await reader.cancel();
        throw new Error("Terminal frame is too large.");
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
