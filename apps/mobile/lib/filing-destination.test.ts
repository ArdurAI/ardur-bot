import { expect, it } from "vitest";
import { filingDestination } from "./filing-destination";

it("opens the group thread or the bot thread that filed the item", () => {
  expect(filingDestination({ botId: "builder", groupId: "squad", messageId: "msg-1" })).toEqual({
    pathname: "/group-thread",
    params: { groupId: "squad", messageId: "msg-1" },
  });
  expect(filingDestination({ botId: "builder", groupId: null, messageId: "msg-2" })).toEqual({
    pathname: "/thread",
    params: { botId: "builder", messageId: "msg-2" },
  });
  expect(filingDestination({ botId: "builder", groupId: "squad", messageId: null })).toEqual({
    pathname: "/group-thread",
    params: { groupId: "squad" },
  });
  expect(filingDestination({ botId: "builder", groupId: null, messageId: null })).toEqual({
    pathname: "/thread",
    params: { botId: "builder" },
  });
});
