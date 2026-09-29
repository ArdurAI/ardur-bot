import type { MessageBlock } from "@ardurbot/contracts";
import { cloudAgentBlockFromPayload } from "./cloud-agent.js";

/** Remove this run's live message and obsolete unscoped progress without reordering history. */
export function takeLiveMessage<Message extends { id: string; runId?: string | null }>(
  messages: readonly Message[],
  liveId: string,
): { previous: Message | undefined; remaining: Message[] } {
  let previous: Message | undefined;
  const remaining: Message[] = [];
  for (const message of messages) {
    if (message.id === liveId) previous = message;
    else if (!message.id.startsWith("progress:") || message.runId) remaining.push(message);
  }
  return { previous, remaining };
}

/**
 * Save a run's durable reply where its live draft sits. The draft's slot is where the
 * reply's text first appeared on screen; anything appended since — a message the owner
 * sent mid-run, another bot's card — stays below the saved reply, matching the server's
 * message sequence. Without a live draft the message appends at the end, and a repeat
 * delivery of the same durable id still updates in place.
 */
export function upsertAtLivePlace<Message extends { id: string; runId?: string | null }>(
  messages: readonly Message[],
  liveId: string,
  next: Message,
): Message[] {
  const { remaining } = takeLiveMessage(messages, liveId);
  const existing = remaining.findIndex((message) => message.id === next.id);
  if (existing >= 0) {
    const updated = [...remaining];
    updated[existing] = next;
    return updated;
  }
  const draftIndex = messages.findIndex((message) => message.id === liveId);
  if (draftIndex < 0) return [...remaining, next];
  // takeLiveMessage can also drop obsolete unscoped drafts; count the survivors that
  // sat before this draft to land exactly on its slot.
  const slot = messages
    .slice(0, draftIndex)
    .filter((message) => !message.id.startsWith("progress:") || message.runId).length;
  return [...remaining.slice(0, slot), next, ...remaining.slice(slot)];
}

export function updateCloudAgentMessages<Message extends { id: string; blocks: MessageBlock[] }>(
  messages: readonly Message[],
  payload: Record<string, unknown>,
): Message[] {
  const agentId = String(payload.agentId ?? "");
  const messageId = String(payload.messageId ?? "");
  const block = cloudAgentBlockFromPayload(payload);
  return messages.map((message) => {
    if (
      (messageId && message.id === messageId) ||
      message.blocks.some(
        (existing) => existing.kind === "cloud_agent" && existing.agentId === agentId,
      )
    ) {
      return {
        ...message,
        blocks: message.blocks.map((existing) =>
          existing.kind === "cloud_agent" && existing.agentId === agentId ? block : existing,
        ),
      };
    }
    return message;
  });
}
