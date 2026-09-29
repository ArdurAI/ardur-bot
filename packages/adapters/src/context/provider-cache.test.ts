import { describe, expect, it } from "vitest";
import { markStablePrefix } from "./provider-cache.js";

const hour = { type: "ephemeral", ttl: "1h" };
// The shape the SDK sends: markers on the last tool, the system prompt and the latest message.
function payload() {
  return {
    tools: [{ name: "list_bots" }, { name: "web_search", cache_control: hour }],
    system: [{ type: "text", text: "Rules", cache_control: hour }],
    messages: [
      { role: "user", content: "Where is the checklist?" },
      { role: "user", content: "Assistant: Nine items are done." },
      { role: "user", content: "<teammate_directory>\nWriter · busy\n</teammate_directory>" },
      { role: "user", content: [{ type: "text", text: "What is open?", cache_control: hour }] },
    ],
  };
}

describe("provider cache markers", () => {
  it("marks the end of the history that repeats next turn with the SDK's own marker", () => {
    const marked = markStablePrefix(payload(), "Rules", {
      index: 1,
      text: "Assistant: Nine items are done.",
    }) as ReturnType<typeof payload>;
    expect(marked.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Assistant: Nine items are done.", cache_control: hour }],
    });
    expect(marked.system).toEqual(payload().system);
    expect(marked.messages.filter((_, index) => index !== 1)).toEqual(
      payload().messages.filter((_, index) => index !== 1),
    );
  });

  it("leaves the history alone when it cannot place the marker exactly", () => {
    const end = { index: 1, text: "Assistant: Nine items are done." };
    for (const request of [
      // The message at that position is not the expected one.
      { ...payload(), messages: payload().messages.slice(1) },
      // The SDK did not cache this request, so neither does the adapter.
      { ...payload(), tools: [], system: "Rules", messages: payload().messages.slice(0, 3) },
      // All four breakpoints Anthropic allows are already used.
      {
        ...payload(),
        messages: payload().messages.map((message, index) =>
          index === 0
            ? {
                ...message,
                content: [{ type: "text", text: message.content, cache_control: hour }],
              }
            : message,
        ),
      },
    ]) {
      const marked = markStablePrefix(request, undefined, end) as typeof request;
      expect(marked.messages).toEqual(request.messages);
    }
  });
});
