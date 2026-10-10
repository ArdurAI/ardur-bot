import { describe, expect, it } from "vitest";
import {
  composerGroupRecipientNames,
  groupMessageRecipientIds,
  queuedGroupRecipientNames,
} from "./group-message-recipients.js";

const members = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];
const group = {
  members: members.map((m) => ({ botId: m.id, name: m.name })),
  groupRouting: { coordinatorBotId: null, defaultBotId: "b" },
};
describe("shared room recipients", () => {
  it.each([
    ["Each member, reply with your model", ["b"]],
    ["Alpha said Beta was wrong", ["b"]],
    ["@Alpha answer", ["a"]],
    ["@Alpha @Beta answer", ["a", "b"]],
    ["Alpha and Beta, answer", ["a", "b"]],
    ["@everyone answer", ["a", "b"]],
    ["Everyone, each of you reply.", ["a", "b"]],
  ])("projects %s with the same send rule", (text, ids) => {
    expect(groupMessageRecipientIds({ text, members, ...group.groupRouting })).toEqual(ids);
    expect(composerGroupRecipientNames({ group, draft: text })).toEqual(
      ids.map((id) => members.find((m) => m.id === id)!.name),
    );
  });
  it("uses a reply before the fallback, and explicit recipients before a reply", () => {
    expect(composerGroupRecipientNames({ group, draft: "answer", replyBotId: "a" })).toEqual([
      "Alpha",
    ]);
    expect(composerGroupRecipientNames({ group, draft: "@Beta answer", replyBotId: "a" })).toEqual([
      "Beta",
    ]);
  });
  it("keeps coordinator corrections ahead of mentions", () => {
    const input = { text: "do not use @Beta", members, coordinatorBotId: "a", defaultBotId: "b" };
    expect(groupMessageRecipientIds(input)).toEqual(["a"]);
  });
  it("filters foreign recipients and never invents a missing routing snapshot", () => {
    expect(
      groupMessageRecipientIds({
        text: "answer",
        members,
        replyBotId: "foreign",
        coordinatorBotId: "foreign",
        defaultBotId: "foreign",
        explicitMentions: ["foreign"],
      }),
    ).toEqual([]);
    expect(
      composerGroupRecipientNames({ draft: "answer", group: { members: group.members } }),
    ).toEqual([]);
  });
  it("serializes typed bot chips and ignores other targets that change the room", () => {
    expect(
      composerGroupRecipientNames({
        group,
        draft: "answer",
        mentions: [{ kind: "bot", id: "a", name: "Alpha" }],
      }),
    ).toEqual(["Alpha"]);
    for (const kind of ["group", "routine"] as const)
      expect(
        composerGroupRecipientNames({
          group,
          draft: "answer",
          mentions: [{ kind, id: "other", name: "Other" }],
        }),
      ).toEqual([]);
    expect(composerGroupRecipientNames({ group, draft: "/rename New name" })).toEqual([]);
    expect(
      composerGroupRecipientNames({ group, draft: "answer", skill: { name: "review" } }),
    ).toEqual(["Beta"]);
  });
  it("shows only saved queued member runs, deduplicated in roster order", () => {
    expect(
      queuedGroupRecipientNames({
        ...group,
        activeRuns: [
          { botId: "a", status: "running" },
          { botId: "b", status: "queued" },
          { botId: "b", status: "queued" },
          { botId: "foreign", status: "queued" },
          { botId: "a", status: "completed" },
        ],
      }),
    ).toEqual(["Beta"]);
    expect(queuedGroupRecipientNames()).toEqual([]);
  });
});
