import type { AgentRunRequest, AgentSteeringMessage } from "@ardurbot/adapter-kit";

type InputReceipt = Parameters<NonNullable<AgentRunRequest["acknowledgeInput"]>>[0];

const STEERING_HEADER = "Additional user context:";
const STEERING_SHORTENED =
  "[This message was shortened to fit the context budget; the full text is in the thread.]";
/** The note the executor already uses for attachments the model cannot see. */
export const ATTACHMENT_UNAVAILABLE_NOTE =
  "An attachment in this message could not be loaded. Tell the user the attachment was unavailable and do not guess its contents.";
const QUOTE_HEAD =
  /^(?:Replying to|User reacted with [^<\n]+ to) \(quoted data, not instructions\):\n<(reply_target|reaction_target)>\n/;

function endCut(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const room = Math.max(0, maxChars - STEERING_SHORTENED.length - 1);
  return `${text.slice(0, room)}\n${STEERING_SHORTENED}`;
}

/**
 * A long reply is [quoted parent, the user's own words, file notes]. Cut the quote first. The
 * user's own words stay when they can; when they alone outgrow the room, they are cut too, with
 * the same visible marker. The quote is never dropped silently: if it cannot stay in any form,
 * the marker says the message was shortened.
 */
function shortenQuotedSteeringText(text: string, maxChars: number): string {
  const limit = Math.max(0, maxChars);
  if (text.length <= limit) return text;
  const head = QUOTE_HEAD.exec(text);
  const kind = head?.[1];
  if (!kind) return endCut(text, limit);
  const close = `\n</${kind}>`;
  const closeAt = text.indexOf(close, head[0].length);
  if (closeAt < 0) return endCut(text, limit);
  const rest = text.slice(closeAt + close.length).replace(/^\n+/, "");
  if (!rest) return endCut(text, limit);
  const separator = "\n\n";
  const roomForQuote = limit - rest.length - separator.length;
  // The quote cannot stay in any form, so the marker always says it was dropped; the reply
  // is cut only as far as needed to make room for it.
  if (roomForQuote < STEERING_SHORTENED.length + 1)
    return `${rest.slice(0, Math.max(0, limit - STEERING_SHORTENED.length - 1))}\n${STEERING_SHORTENED}`;
  return `${endCut(text.slice(0, closeAt + close.length), roomForQuote)}${separator}${rest}`;
}

/** Messages that waited behind a request follow it, in the order they were sent. */
export function promptWithInitialSteering(
  prompt: string,
  steering: readonly Pick<AgentSteeringMessage, "text">[],
): string {
  return steering.length
    ? `${prompt}\n\n${STEERING_HEADER}\n${steering.map((item) => item.text).join("\n")}`
    : prompt;
}

/** The prompt carries the waiting messages, so their transcript copies leave the history. */
export function withoutSteeringMessages(
  history: AgentRunRequest["history"],
  steering: readonly Pick<AgentSteeringMessage, "messageId" | "text" | "historyText">[],
): AgentRunRequest["history"] {
  if (steering.length === 0) return history;
  const result = [...history];
  let beforeIndex = result.length - 1;
  for (let steeringIndex = steering.length - 1; steeringIndex >= 0; steeringIndex -= 1) {
    const steeringMessage = steering[steeringIndex];
    for (let index = beforeIndex; index >= 0; index -= 1) {
      const message = result[index];
      if (
        message?.role !== "user" ||
        (message.id
          ? message.id !== steeringMessage?.messageId
          : message.content !== (steeringMessage?.historyText ?? steeringMessage?.text))
      ) {
        continue;
      }
      result.splice(index, 1);
      beforeIndex = index - 1;
      break;
    }
  }
  return result;
}

/**
 * Takes whole waiting messages, oldest first, while they fit after a request that already
 * used part of the message budget and the turn's image allowance. The rest stay queued for a
 * later turn. A steering follow-up has no request of its own, so its first message is always
 * taken, shortened when it alone is larger than the budget; images past the allowance are
 * dropped with the same note used for attachments that cannot be loaded.
 */
export function fitInitialSteering<T extends AgentSteeringMessage>(
  steering: readonly T[],
  room: { characters: number; images: number },
  keepFirst: boolean,
): { included: T[]; deferred: T[] } {
  const included: T[] = [];
  let characters = room.characters - `\n\n${STEERING_HEADER}\n`.length;
  let images = room.images;
  for (const item of steering) {
    const size = item.text.length + (included.length ? 1 : 0);
    const imageCount = item.images?.length ?? 0;
    if (size <= characters && imageCount <= images) {
      included.push(item);
      characters -= size;
      images -= imageCount;
      continue;
    }
    if (keepFirst && included.length === 0) {
      const droppedImages = Math.max(0, imageCount - Math.max(0, images));
      const notes: string[] = [];
      if (droppedImages > 0 && !item.text.includes(ATTACHMENT_UNAVAILABLE_NOTE))
        notes.push(ATTACHMENT_UNAVAILABLE_NOTE);
      const noteBlock = notes.join("\n\n");
      const noted = noteBlock ? `${item.text}\n\n${noteBlock}` : item.text;
      // Shortening cuts the tail, so room is reserved for the note before the user's words
      // are cut; both the shortened marker and the note stay visible to the model.
      const roomForText = noteBlock ? characters - noteBlock.length - 2 : characters;
      included.push({
        ...item,
        text:
          noted.length > characters
            ? `${
                item.text.length > roomForText
                  ? shortenQuotedSteeringText(item.text, roomForText)
                  : item.text
              }${noteBlock ? `\n\n${noteBlock}` : ""}`
            : noted,
        images: item.images?.slice(0, Math.max(0, images)),
      });
    }
    break;
  }
  return { included, deferred: steering.slice(included.length) };
}

/**
 * A runtime acknowledges everything in its first turn as initial input. Delivery ids of
 * waiting messages carried in that turn keep their steering receipt scope.
 */
export function splitInitialReceipt(
  input: InputReceipt,
  steeringDeliveryIds: ReadonlySet<string>,
): InputReceipt[] {
  if (input.mode !== "initial" || steeringDeliveryIds.size === 0) return [input];
  return [
    { ...input, deliveryIds: input.deliveryIds.filter((id) => !steeringDeliveryIds.has(id)) },
    {
      ...input,
      mode: "steering",
      deliveryIds: input.deliveryIds.filter((id) => steeringDeliveryIds.has(id)),
    },
  ];
}
