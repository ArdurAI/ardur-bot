import type { AgentInputImage } from "@ardurbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { messageToAgentHistoryText } from "./reply-context.js";
import {
  fitInitialSteering,
  promptWithInitialSteering,
  splitInitialReceipt,
  withoutSteeringMessages,
} from "./steering-input.js";

const image: AgentInputImage = { name: "shot.png", mimeType: "image/png", data: new Uint8Array() };

function waiting(id: string, text: string, images?: AgentInputImage[]) {
  return { id, messageId: `message-${id}`, text, historyText: text, images };
}

describe("promptWithInitialSteering", () => {
  it("puts waiting messages after the request, in the order they were sent", () => {
    const prompt = promptWithInitialSteering("Quote of X\n\nmove it to Monday", [
      waiting("1", "also notify the team"),
      waiting("2", "and the client"),
    ]);

    expect(prompt).toBe(
      "Quote of X\n\nmove it to Monday\n\nAdditional user context:\nalso notify the team\nand the client",
    );
    expect(promptWithInitialSteering("request", [])).toBe("request");
  });
});

describe("withoutSteeringMessages", () => {
  it("drops the transcript copy of each waiting message and keeps the rest", () => {
    const history = [
      { id: "message-0", role: "user" as const, content: "earlier" },
      { id: "message-1", role: "user" as const, content: "also notify the team" },
      { role: "user" as const, content: "and the client" },
      { id: "reply-1", role: "assistant" as const, content: "and the client" },
    ];

    expect(
      withoutSteeringMessages(history, [
        waiting("1", "also notify the team"),
        waiting("2", "and the client"),
      ]),
    ).toEqual([history[0], history[3]]);
  });
});

describe("fitInitialSteering", () => {
  const header = "\n\nAdditional user context:\n".length;

  it("takes whole messages in order and leaves the rest queued", () => {
    const steering = [
      waiting("1", "a".repeat(10)),
      waiting("2", "b".repeat(20)),
      waiting("3", "c"),
    ];

    const fitted = fitInitialSteering(steering, { characters: header + 25, images: 8 }, false);

    // The short third message stays behind the second so the order is never reshuffled.
    expect(fitted.included.map((item) => item.id)).toEqual(["1"]);
    expect(fitted.deferred.map((item) => item.id)).toEqual(["2", "3"]);
  });

  it("never lets the carried messages outgrow the room they were given", () => {
    const steering = [waiting("1", "a".repeat(10)), waiting("2", "b".repeat(10))];
    const room = header + 21;

    const fitted = fitInitialSteering(steering, { characters: room, images: 8 }, false);

    expect(fitted.included).toHaveLength(2);
    expect(promptWithInitialSteering("", fitted.included).length).toBe(room);
  });

  it("leaves a message queued when its images would pass the turn's allowance", () => {
    const steering = [waiting("1", "first", [image, image]), waiting("2", "second", [image])];

    const fitted = fitInitialSteering(steering, { characters: 10_000, images: 2 }, false);

    expect(fitted.included.map((item) => item.id)).toEqual(["1"]);
    expect(fitted.deferred.map((item) => item.id)).toEqual(["2"]);
  });

  it("queues an oversized first message behind a request of its own", () => {
    const fitted = fitInitialSteering(
      [waiting("1", "a".repeat(500))],
      {
        characters: 200,
        images: 8,
      },
      false,
    );

    expect(fitted.included).toEqual([]);
    expect(fitted.deferred.map((item) => item.id)).toEqual(["1"]);
  });

  it("shortens a follow-up's oversized first message instead of failing or requeueing it", () => {
    const steering = [waiting("1", "a".repeat(500)), waiting("2", "later")];

    const fitted = fitInitialSteering(steering, { characters: 200, images: 8 }, true);

    expect(fitted.included).toHaveLength(1);
    expect(fitted.included[0]?.text).toContain("shortened to fit the context budget");
    expect(fitted.included[0]?.historyText).toBe("a".repeat(500));
    expect(promptWithInitialSteering("", fitted.included).length).toBeLessThanOrEqual(200);
    expect(fitted.deferred.map((item) => item.id)).toEqual(["2"]);
  });

  it("shortens the quoted parent and keeps the user's own reply", () => {
    const parent = "<li>a</li>\n".repeat(4_000);
    const reply = "move it to Monday";
    const text = messageToAgentHistoryText({
      id: "reply-1",
      threadId: "thread-1",
      role: "user",
      blocks: [{ kind: "text", text: reply }],
      replyTo: {
        id: "parent-1",
        threadId: "thread-1",
        role: "assistant",
        blocks: [{ kind: "text", text: parent }],
      },
    });
    expect(text).toContain("<reply_target>");
    expect(text).toContain(reply);
    expect(text.length).toBeGreaterThan(8_000);

    const fitted = fitInitialSteering([waiting("1", text)], { characters: 4_000, images: 8 }, true);

    const kept = fitted.included[0]?.text ?? "";
    expect(kept).toContain(reply);
    expect(kept).toContain("shortened to fit the context budget");
    expect(kept.indexOf(reply)).toBeGreaterThan(
      kept.indexOf("shortened to fit the context budget"),
    );
  });

  it("shortens the user's own words as a last resort and marks the cut", () => {
    const reply = "r".repeat(500);
    const text = messageToAgentHistoryText({
      id: "reply-1",
      threadId: "thread-1",
      role: "user",
      blocks: [{ kind: "text", text: reply }],
      replyTo: {
        id: "parent-1",
        threadId: "thread-1",
        role: "assistant",
        blocks: [{ kind: "text", text: "<li>a</li>\n".repeat(20) }],
      },
    });

    // The reply alone is larger than the room, so even the user's own words have to give.
    const fitted = fitInitialSteering([waiting("1", text)], { characters: 300, images: 8 }, true);

    const kept = fitted.included[0]?.text ?? "";
    expect(kept.length).toBeLessThanOrEqual(300);
    expect(kept).toContain("shortened to fit the context budget");
    expect(kept).toContain("rrrrrr");
  });

  it("says the quote was dropped when the room cannot hold it", () => {
    const reply = "please move the launch review to Monday afternoon";
    const text = messageToAgentHistoryText({
      id: "reply-1",
      threadId: "thread-1",
      role: "user",
      blocks: [{ kind: "text", text: reply }],
      replyTo: {
        id: "parent-1",
        threadId: "thread-1",
        role: "assistant",
        blocks: [{ kind: "text", text: "<li>a</li>\n".repeat(2_000) }],
      },
    });
    // Room for the reply but not for the quote: 90 characters of quote room, marker needs 93.
    const room = reply.length + 2 + 90;

    const fitted = fitInitialSteering([waiting("1", text)], { characters: room, images: 8 }, true);

    const kept = fitted.included[0]?.text ?? "";
    expect(kept.length).toBeLessThanOrEqual(room);
    expect(kept).toContain("shortened to fit the context budget");
    expect(kept).toContain("please move the laun");
  });

  it("notes dropped images when a follow-up's first message exceeds the image allowance", () => {
    const steering = [waiting("1", "look at these screenshots", [image, image, image, image])];

    const fitted = fitInitialSteering(steering, { characters: 10_000, images: 2 }, true);

    expect(fitted.included).toHaveLength(1);
    expect(fitted.included[0]?.images).toHaveLength(2);
    expect(fitted.included[0]?.text).toContain("could not be loaded");
    expect(fitted.deferred).toEqual([]);
  });

  it("keeps the dropped-image note inside the character room", () => {
    const note = "An attachment in this message could not be loaded.";
    const steering = [waiting("1", "a".repeat(600), [image, image, image])];

    const fitted = fitInitialSteering(steering, { characters: 500, images: 1 }, true);

    const kept = fitted.included[0]?.text ?? "";
    expect(kept.length).toBeLessThanOrEqual(500);
    expect(kept).toContain(note);
    expect(kept).toContain("shortened to fit the context budget");
  });
});

describe("splitInitialReceipt", () => {
  const receipt = {
    runId: "run-1",
    leaseFence: 2,
    deliveryIds: ["quiet-1", "steer-1"],
    mode: "initial" as const,
  };

  it("keeps waiting messages carried in the first turn in the steering receipt scope", () => {
    expect(splitInitialReceipt(receipt, new Set(["steer-1"]))).toEqual([
      { ...receipt, deliveryIds: ["quiet-1"] },
      { ...receipt, mode: "steering", deliveryIds: ["steer-1"] },
    ]);
  });

  it("leaves other receipts unchanged", () => {
    expect(splitInitialReceipt(receipt, new Set())).toEqual([receipt]);
    const steering = { ...receipt, mode: "steering" as const };
    expect(splitInitialReceipt(steering, new Set(["steer-1"]))).toEqual([steering]);
  });
});
