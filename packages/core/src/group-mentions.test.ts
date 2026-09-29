import { describe, expect, it } from "vitest";
import {
  hasMentionToken,
  inferHandoffTargetBotId,
  inferHandoffTargetName,
  resolveAddressedBotIds,
  resolveGroupTargetBotIds,
} from "./group-mentions.js";

const members = [
  { id: "a", name: "BotA" },
  { id: "b", name: "BotB" },
  { id: "c", name: "Writer" },
];

describe("hasMentionToken", () => {
  it("requires a boundary after the complete member name", () => {
    expect(hasMentionToken("Ask @Ann to review", "Ann")).toBe(true);
    expect(hasMentionToken("Ask @Ann, then continue", "Ann")).toBe(true);
    expect(hasMentionToken("Ask @Anna to review", "Ann")).toBe(false);
    expect(hasMentionToken("name@Ann", "Ann")).toBe(false);
    expect(hasMentionToken("contact@everyone", "everyone")).toBe(false);
  });

  it("supports multi-word and Unicode member names", () => {
    expect(hasMentionToken("Ask @Research Writer and @Éditeur", "Research Writer")).toBe(true);
    expect(hasMentionToken("Ask @Research Writer and @Éditeur", "Éditeur")).toBe(true);
  });
});

describe("resolveGroupTargetBotIds", () => {
  it("returns mentioned bots from text", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@BotA gather sources. @BotB summarize.",
        members,
      }),
    ).toEqual(["a", "b"]);
  });

  it("returns all members for @everyone", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@everyone please review",
        members,
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("merges explicit mentions", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello",
        members,
        explicitMentions: ["b"],
      }),
    ).toEqual(["b"]);
  });

  it("matches multi-word and Unicode names without prefix collisions", () => {
    const namedMembers = [
      { id: "research", name: "Research Writer" },
      { id: "edit", name: "Éditeur" },
      { id: "ann", name: "Ann" },
      { id: "anna", name: "Anna" },
    ];
    expect(
      resolveGroupTargetBotIds({
        text: "@Research Writer compare this with @Éditeur and @Anna.",
        members: namedMembers,
      }),
    ).toEqual(["research", "edit", "anna"]);
  });

  it("ignores explicit mentions for bots that are not group members", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello",
        members,
        explicitMentions: ["b", "outsider"],
      }),
    ).toEqual(["b"]);
  });

  it("picks the first member when unmentioned", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello team",
        members,
      }),
    ).toEqual(["a"]);
  });
});

describe("resolveAddressedBotIds", () => {
  const group = [
    { id: "chief", name: "Chief" },
    { id: "radiant", name: "Radiant" },
  ];

  it("routes a message that starts by addressing a member by name", () => {
    expect(resolveAddressedBotIds({ text: "Chief, did rad do it?", members: group })).toEqual([
      "chief",
    ]);
    expect(resolveAddressedBotIds({ text: "chief: status?", members: group })).toEqual(["chief"]);
    expect(resolveAddressedBotIds({ text: "hey Chief what happened", members: group })).toEqual([
      "chief",
    ]);
    expect(resolveAddressedBotIds({ text: "@chief why", members: group })).toEqual(["chief"]);
    expect(resolveAddressedBotIds({ text: "so chief, did rad do it?", members: group })).toEqual([
      "chief",
    ]);
    expect(resolveAddressedBotIds({ text: "ok, Chief, status?", members: group })).toEqual([
      "chief",
    ]);
    expect(resolveAddressedBotIds({ text: "hey, Chief what's up", members: group })).toEqual([
      "chief",
    ]);
    expect(resolveAddressedBotIds({ text: "Chief. Status?", members: group })).toEqual(["chief"]);
    expect(resolveAddressedBotIds({ text: "Chief", members: group })).toEqual(["chief"]);
  });

  it("addresses several members at the start", () => {
    const trio = [
      { id: "chief", name: "Chief" },
      { id: "radiant", name: "Radiant" },
      { id: "writer", name: "Writer" },
    ];
    expect(resolveAddressedBotIds({ text: "Chief and Radiant, status?", members: group })).toEqual([
      "chief",
      "radiant",
    ]);
    expect(resolveAddressedBotIds({ text: "Chief, and Radiant, status?", members: group })).toEqual(
      ["chief", "radiant"],
    );
    expect(resolveAddressedBotIds({ text: "Chief, Radiant: status?", members: group })).toEqual([
      "chief",
      "radiant",
    ]);
    expect(
      resolveAddressedBotIds({ text: "Chief, Radiant, and Writer: go", members: trio }),
    ).toEqual(["chief", "radiant", "writer"]);
  });

  it("does not reroute a name used mid-sentence as a subject", () => {
    expect(resolveAddressedBotIds({ text: "Chief is great.", members: group })).toEqual([]);
    expect(resolveAddressedBotIds({ text: "Radiant light everywhere", members: group })).toEqual(
      [],
    );
    expect(resolveAddressedBotIds({ text: "ask chief why this happened", members: group })).toEqual(
      [],
    );
    expect(
      resolveAddressedBotIds({ text: "Radiant said Chief was wrong", members: group }),
    ).toEqual([]);
    expect(
      resolveAddressedBotIds({ text: "why did you answer and why not chief", members: group }),
    ).toEqual([]);
    expect(
      resolveAddressedBotIds({ text: "but since Chief, is the Chief of ...", members: group }),
    ).toEqual([]);
    expect(resolveAddressedBotIds({ text: "hi there", members: group })).toEqual([]);
  });

  it("requires the whole name at a word boundary", () => {
    const annaGroup = [
      { id: "ann", name: "Ann" },
      { id: "anna", name: "Anna" },
    ];
    expect(resolveAddressedBotIds({ text: "Chiefly speaking", members: group })).toEqual([]);
    expect(resolveAddressedBotIds({ text: "Anna, hi", members: annaGroup })).toEqual(["anna"]);
  });

  it("supports multi-word and Unicode member names", () => {
    const namedGroup = [
      { id: "research", name: "Research Writer" },
      { id: "edit", name: "Éditeur" },
    ];
    expect(
      resolveAddressedBotIds({ text: "Research Writer, please compare", members: namedGroup }),
    ).toEqual(["research"]);
    expect(resolveAddressedBotIds({ text: "Éditeur: check this", members: namedGroup })).toEqual([
      "edit",
    ]);
    expect(resolveAddressedBotIds({ text: "hey éditeur", members: namedGroup })).toEqual(["edit"]);
  });
});

describe("inferHandoffTargetName", () => {
  it("picks Writer when BotA is also mentioned", () => {
    expect(inferHandoffTargetName("@BotA hand this to Writer for the draft")).toBe("Writer");
  });
});

describe("inferHandoffTargetBotId", () => {
  it("recognizes hand this to Writer", () => {
    expect(inferHandoffTargetBotId("hand this to Writer for the draft", members)).toBe("c");
  });

  it("recognizes @Writer take the draft", () => {
    expect(inferHandoffTargetBotId("@Writer take the draft", members)).toBe("c");
  });

  it("resolves Writer from mixed mention prompt", () => {
    expect(inferHandoffTargetBotId("@BotA hand this to Writer for the draft", members)).toBe("c");
  });

  it("resolves multi-word handoff targets", () => {
    expect(
      inferHandoffTargetBotId("hand this to Research Writer for the draft", [
        ...members,
        { id: "research", name: "Research Writer" },
      ]),
    ).toBe("research");
  });
});
