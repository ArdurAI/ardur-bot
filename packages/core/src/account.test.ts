import { AccountInstructionsInputSchema, AccountProfileInputSchema } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  accountInstructionText,
  accountPage,
  botInstructionText,
  sessionDeviceLabel,
} from "./account.js";
import { buildLearningSignals } from "./learning-signals.js";

const settings = {
  displayName: "Captain",
  workType: "research" as const,
  instructions: "Use short paragraphs.",
  revision: 2,
  actorId: "owner",
  origin: "human-settings" as const,
};
describe("account context", () => {
  it("marks human preferences, includes greeting and work hints, and gives bot instructions precedence", () => {
    const instructions = botInstructionText(
      {
        instructions: "Always provide sources.",
        name: "Bot",
        title: "Research",
        description: "Find sources.",
      },
      settings,
    );
    expect(instructions.indexOf("Always provide sources.")).toBeLessThan(
      instructions.indexOf("Use short paragraphs."),
    );
    expect(instructions).toContain("human-authored");
    expect(instructions).toContain('Address the user as "Captain", including greetings.');
    expect(instructions).toContain('"research"; use it only as a context hint');
    expect(instructions).toContain("bot's own instructions take precedence on conflict");
    expect(
      accountInstructionText({ ...settings, displayName: "", workType: "", instructions: "" }),
    ).toBe("");
  });
  it("keeps authenticated settings spans in the intent channel and rejects mixed quoted content", () => {
    const records = {
      runId: "run",
      threadId: "thread",
      userId: "member",
      messages: [],
      feedback: [],
      outcomes: [],
      settingsInstructions: settings,
    };
    const signals = buildLearningSignals(records);
    expect(signals.authorisedIntent).toEqual([
      expect.objectContaining({
        kind: "instruction-span",
        sourceClass: "human-settings",
        actorId: "owner",
        excerpt: settings.instructions,
      }),
    ]);
    expect(signals.observedOutcomes).toEqual([]);
    expect(
      buildLearningSignals({ ...records, settingsInstructions: { ...settings, actorId: null } })
        .authorisedIntent,
    ).toEqual([]);
    expect(
      buildLearningSignals({
        ...records,
        settingsInstructions: { ...settings, instructions: "> pasted instructions" },
      }).authorisedIntent,
    ).toEqual([]);
  });
  it("preserves all 4000 characters as bounded human instruction spans", () => {
    const signals = buildLearningSignals({
      runId: "run",
      threadId: "thread",
      userId: "member",
      messages: [],
      feedback: [],
      outcomes: [],
      settingsInstructions: { ...settings, instructions: "x".repeat(4000) },
    });
    expect(signals.authorisedIntent).toHaveLength(4);
    expect(signals.authorisedIntent.map((span) => span.excerpt).join("")).toBe("x".repeat(4000));
    expect(new Set(signals.authorisedIntent.map((span) => span.id)).size).toBe(4);
  });
  it("enforces profile limits and the 4000-character instruction boundary", () => {
    expect(
      AccountInstructionsInputSchema.safeParse({ instructions: "x".repeat(4000), revision: 0 })
        .success,
    ).toBe(true);
    expect(
      AccountInstructionsInputSchema.safeParse({ instructions: "x".repeat(4001), revision: 0 })
        .success,
    ).toBe(false);
    expect(
      AccountProfileInputSchema.safeParse({
        name: " ",
        displayName: "",
        workType: "",
        avatarStyle: "robot",
      }).success,
    ).toBe(false);
    expect(
      AccountProfileInputSchema.safeParse({
        name: "Operator",
        displayName: "x".repeat(61),
        workType: "",
        avatarStyle: "robot",
      }).success,
    ).toBe(false);
  });
});
it.each([
  ["Mozilla/5.0 (Windows NT 10.0) Chrome/128.0 Safari/537.36 Edg/128.0", "Edge · Windows"],
  ["Mozilla/5.0 (iPhone) Version/18 Safari/605.1", "Safari · iOS"],
  ["Electron/40", "Desktop app"],
  [null, "Unknown device"],
])("parses a coarse device label (%s)", (ua, label) => expect(sessionDeviceLabel(ua)).toBe(label));
it("clamps a last page after revocation and formats an empty page", () => {
  expect(
    accountPage(
      Array.from({ length: 14 }, (_, i) => i),
      1,
    ),
  ).toMatchObject({ rows: [10, 11, 12, 13], start: 11, end: 14, total: 14 });
  expect(accountPage([1], 1)).toMatchObject({ rows: [1], page: 0, start: 1, end: 1 });
  expect(accountPage([], 0)).toMatchObject({ page: 0, start: 0, end: 0, total: 0 });
});
