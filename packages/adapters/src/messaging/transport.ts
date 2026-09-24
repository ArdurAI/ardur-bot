import type {
  ChatCard,
  ChatDestination,
  ChatEvent,
  ChatInstallationInput,
} from "@ardurbot/contracts";

export type ReceiverState = Record<string, string | number>;
export interface ReceiverContext {
  signal: AbortSignal;
  load(): Promise<ReceiverState>;
  save(state: ReceiverState): Promise<void>;
  accept(event: ChatEvent): Promise<void>;
}
export interface DeliveryCheckpoint {
  sentChunks: number;
  firstMessageId: string;
  sent(index: number, messageId: string): Promise<void>;
}
export interface ChatTransport {
  verify(signal: AbortSignal): Promise<{ accountId: string; workspaceId?: string }>;
  receive(context: ReceiverContext): Promise<void>;
  send(
    destination: ChatDestination,
    card: ChatCard,
    signal: AbortSignal,
    checkpoint?: DeliveryCheckpoint,
  ): Promise<string>;
}
export type ChatCredentials = ChatInstallationInput & { accountId?: string };
export interface TransportIO {
  fetch: typeof fetch;
  socket(url: string): WebSocket;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
export const transportIO: TransportIO = {
  fetch: (...args) => fetch(...args),
  socket: (url) => new WebSocket(url),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        done();
        reject(new Error("Receiver stopped."));
      };
      const timer = setTimeout(() => {
        done();
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
    }),
};
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function string(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : "";
}
export class ProviderResponseError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly formatting = false,
  ) {
    super("The chat service could not complete this request.");
  }
}
export async function request(
  io: TransportIO,
  url: string,
  token: string | undefined,
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await io.fetch(url, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
        headers: { "content-type": "application/json", ...(token ? { authorization: token } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ProviderResponseError(0);
    }
    const value = record(await response.json().catch(() => ({})));
    const retry = Number(
      record(value.parameters).retry_after ??
        value.retry_after ??
        response.headers.get("retry-after"),
    );
    if (response.status === 429 || value.error_code === 429 || value.error === "ratelimited") {
      const ms = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry * 1000) : 1000;
      if (attempt >= 2 || ms > 30_000) throw new ProviderResponseError(429, ms);
      await io.sleep(ms, signal);
      continue;
    }
    if (!response.ok || value.ok === false)
      throw new ProviderResponseError(
        response.status === 200 ? 400 : response.status,
        undefined,
        /parse|markdown|entities/i.test(string(value.description)),
      );
    return value;
  }
}

/** Split by Unicode code points and reopen fenced blocks; never split a surrogate pair. */
export function chatChunks(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let fence = false;
  for (const line of text.split(/(?<=\n)/)) {
    const points = Array.from(line);
    const toggles = line.trimStart().startsWith("```");
    for (const point of points) {
      if (current.length + point.length + 8 > limit) {
        chunks.push(current + (fence ? "\n```" : ""));
        current = fence ? "```\n" : "";
      }
      current += point;
    }
    if (toggles) fence = !fence;
  }
  if (current) chunks.push(current + (fence ? "\n```" : ""));
  return chunks;
}

/** WebSocket callbacks have no backpressure. Close before an unbounded promise chain develops. */
export async function socketSession(
  io: TransportIO,
  url: string,
  signal: AbortSignal,
  onMessage: (payload: Record<string, unknown>, socket: WebSocket) => Promise<void>,
  onOpen?: (socket: WebSocket) => void,
  onClose?: (code: number) => Promise<void>,
): Promise<void> {
  signal.throwIfAborted();
  const socket = io.socket(url);
  let failed = false;
  let pending = 0;
  let chain = Promise.resolve();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (failure: boolean) => {
      failed ||= failure;
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      try {
        socket.close(4000);
      } catch {
        /* Already closed during shutdown. */
      }
      void chain.finally(() => (failed ? reject(new Error("Chat connection closed.")) : resolve()));
    };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => onOpen?.(socket));
    socket.addEventListener("close", (event) => {
      chain = chain.then(() => onClose?.(event.code));
      finish(false);
    });
    socket.addEventListener("error", () => finish(true));
    socket.addEventListener("message", (event) => {
      if (settled) return;
      if (typeof event.data !== "string" || event.data.length > 256_000 || ++pending > 64) {
        finish(true);
        return;
      }
      chain = chain
        .then(async () => {
          if (!failed) await onMessage(record(JSON.parse(event.data)), socket);
        })
        .catch(() => {
          finish(true);
        })
        .finally(() => {
          pending--;
        });
    });
  });
}
