import { expect, it } from "vitest";
import { routeIncoming } from "./route.js";

const bots = ["chief", "worker", "researcher"].map((botId) => ({
  botId,
  name: botId,
  threadId: `thread-${botId}`,
}));
it("resolves every routing rule in order without any model", () => {
  const input = {
    bots,
    text: "@worker check this",
    replyTo: bots[2],
    groupCoordinatorId: "chief",
    lastActiveThread: bots[1],
    spaceCoordinatorId: "researcher",
  };
  expect(routeIncoming(input)).toMatchObject({
    botId: "worker",
    rule: "mention",
    routedByDefault: false,
  });
  expect(routeIncoming({ ...input, text: "Review" })).toMatchObject({
    botId: "researcher",
    rule: "reply",
  });
  expect(routeIncoming({ ...input, text: "Review", replyTo: null })).toMatchObject({
    botId: "chief",
    rule: "group-coordinator",
  });
  expect(
    routeIncoming({ ...input, text: "Review", replyTo: null, groupCoordinatorId: null }),
  ).toMatchObject({ botId: "worker", rule: "last-active-thread" });
  expect(routeIncoming({ bots, text: "Review", spaceCoordinatorId: "researcher" })).toMatchObject({
    botId: "researcher",
    rule: "space-coordinator",
  });
  expect(routeIncoming({ bots, text: "Review" })).toEqual({
    botId: "chief",
    threadId: "thread-chief",
    rule: "default",
    routedByDefault: true,
  });
});
it("rejects targets outside the authorized roster and handles multiword mentions literally", () => {
  expect(
    routeIncoming({
      bots,
      text: "Review",
      replyTo: { botId: "chief", threadId: "private-other-thread" },
      groupCoordinatorId: "foreign",
    })?.rule,
  ).toBe("default");
  expect(
    routeIncoming({
      bots: [{ botId: "chief", name: "Chief of Staff", threadId: "group" }],
      text: "@Chief of Staff, help",
    })?.rule,
  ).toBe("mention");
  expect(routeIncoming({ bots: [], text: "Review" })).toBeNull();
});
