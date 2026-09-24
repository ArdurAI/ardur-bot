import type { ChatEvent } from "@ardurbot/contracts";
import { looksLikeChatSecret } from "@ardurbot/contracts";
import type { TransportIO } from "./transport.js";

export interface ChatAttachmentSource {
  name: string;
  type: string;
  size: number;
  open(): Promise<Response>;
}
/** Inspect bounded UTF-8 text before any persistence. Binary files stay on authenticated home surfaces. */
export async function readChatAttachments(
  event: ChatEvent,
  sources: ChatAttachmentSource[],
): Promise<ChatEvent> {
  if (!event.attachmentCount) return event;
  if (event.attachmentCount > 3 || event.attachmentBytes > 256_000)
    return { ...event, rejectedAttachment: "size" };
  if (
    sources.length !== event.attachmentCount ||
    sources.some((source) => !/^text\/(plain|markdown|csv)$|^application\/json$/.test(source.type))
  )
    return { ...event, rejectedAttachment: "type" };
  const attachments: Array<{ name: string; text: string }> = [];
  let bytes = 0;
  for (const source of sources) {
    if (source.size > 256_000 || source.size < 0 || source.name.length > 160)
      return { ...event, rejectedAttachment: "size" };
    let response: Response;
    try {
      response = await source.open();
    } catch {
      return { ...event, rejectedAttachment: "type" };
    }
    if (!response.ok || !response.body) return { ...event, rejectedAttachment: "type" };
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 256_000) return { ...event, rejectedAttachment: "size" };
        text += decoder.decode(part.value, { stream: true });
        if (text.length > 24_000) return { ...event, rejectedAttachment: "size" };
      }
      text += decoder.decode();
    } catch {
      return { ...event, rejectedAttachment: "type" };
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (looksLikeChatSecret(text) || looksLikeChatSecret(source.name))
      return { ...event, rejectedAttachment: "secret" };
    attachments.push({ name: source.name, text });
  }
  return { ...event, attachments };
}

export function fetchChatFile(
  io: TransportIO,
  rawUrl: string,
  hosts: string[],
  signal: AbortSignal,
  token?: string,
) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password || !hosts.includes(url.hostname))
    throw new Error("This attachment is unavailable.");
  return io.fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    redirect: "error",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
