import { describe, expect, it } from "vitest";
import {
  answerableAskMessageIds,
  resolveAskChoice,
  selectedAskActionLabel,
} from "./answerable-ask.js";

describe("answerableAskMessageIds", () => {
  const ask = (id: string, runId: string, status = "pending") => ({
    id,
    runId,
    blocks: [{ kind: "ask", status }],
  });

  it("finds a waiting prompt even when a newer group run is active", () => {
    expect([
      ...answerableAskMessageIds({
        run: { id: "run-newer", status: "running" },
        activeRuns: [
          { id: "run-newer", status: "running" },
          { id: "run-waiting", status: "waiting_input" },
        ],
        messages: [ask("ask-1", "run-waiting")],
      }),
    ]).toEqual(["ask-1"]);
  });

  it("ignores answered prompts and prompts from non-waiting runs", () => {
    expect(
      answerableAskMessageIds({
        run: { id: "run-1", status: "running" },
        messages: [ask("ask-1", "run-1")],
      }).size,
    ).toBe(0);
    expect(
      answerableAskMessageIds({
        run: { id: "run-1", status: "waiting_input" },
        messages: [ask("ask-1", "run-1", "answered")],
      }).size,
    ).toBe(0);
    expect(answerableAskMessageIds(null).size).toBe(0);
  });

  it("lets the person answer every room bot that waits at the same time", () => {
    const answerable = answerableAskMessageIds({
      run: { id: "run-b", status: "waiting_input" },
      activeRuns: [
        { id: "run-a", status: "waiting_input" },
        { id: "run-b", status: "waiting_input" },
        { id: "run-c", status: "running" },
      ],
      messages: [
        ask("ask-a", "run-a"),
        { id: "text-c", runId: "run-c", blocks: [{ kind: "text" }] },
        ask("ask-b", "run-b"),
      ],
    });
    expect([...answerable].sort()).toEqual(["ask-a", "ask-b"]);
  });

  it("offers only the newest unanswered question of one waiting run", () => {
    const answerable = answerableAskMessageIds({
      run: { id: "run-a", status: "waiting_input" },
      messages: [ask("ask-old", "run-a"), ask("ask-new", "run-a")],
    });
    expect([...answerable]).toEqual(["ask-new"]);
  });
});

describe("selectedAskActionLabel", () => {
  it("maps a choice answer id to its user-facing label", () => {
    expect(
      selectedAskActionLabel("choice-2", [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ]),
    ).toBe("Seoul");
  });

  it("falls back to the answer when an action is unavailable", () => {
    expect(selectedAskActionLabel("custom", undefined)).toBe("custom");
  });
});

describe("resolveAskChoice", () => {
  const actions = [
    { id: "choice-1", label: "Berlin" },
    { id: "choice-2", label: "Seoul" },
  ];

  it("matches an offered choice by id or label", () => {
    expect(resolveAskChoice("choice-2", actions)).toEqual({ id: "choice-2", label: "Seoul" });
    expect(resolveAskChoice(" seoul ", actions)).toEqual({ id: "choice-2", label: "Seoul" });
  });

  it("leaves unmatched free-text as a custom answer", () => {
    expect(resolveAskChoice("Toronto", actions)).toBeUndefined();
  });
});
