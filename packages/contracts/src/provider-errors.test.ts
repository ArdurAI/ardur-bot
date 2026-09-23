import { expect, it } from "vitest";
import { ProductEventSchema } from "./events.js";
import { RunFailurePayloadSchema } from "./provider-errors.js";

it("parses typed failures while accepting historical payloads", () => {
  expect(RunFailurePayloadSchema.parse({ error: "Failed" })).toEqual({ error: "Failed" });
  expect(RunFailurePayloadSchema.parse({})).toEqual({});
  const payload = { error: "Denied", providerErrorKind: "model-unavailable" };
  const event = {
    id: "event-1",
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq: 1,
    type: "run.failed",
    createdAt: "2026-09-23",
    payload,
  };
  expect(ProductEventSchema.parse(event).payload).toEqual(payload);
  expect(
    ProductEventSchema.safeParse({
      ...event,
      payload: { ...payload, providerErrorKind: "invented" },
    }).success,
  ).toBe(false);
  expect(ProductEventSchema.safeParse({ ...event, payload: {} }).success).toBe(true);
});
