import { expect, it } from "vitest";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

it.each([RU_MESSAGES, ZH_MESSAGES])(
  "keeps review copy translated and board placeholders intact",
  (messages) => {
    for (const key of [
      "Review result",
      "Pass",
      "Fail",
      "Unknown",
      "Accept result",
      "Reject result",
      "Result changed; review again.",
      "Work is still active.",
      "Please address the failing conditions.",
      "Final owner review",
      "Could not review result. Try again.",
    ]) {
      expect(messages[key]).toBeTruthy();
      expect(messages[key]).not.toBe(key);
      expect(messages[key]).not.toContain("\\n");
    }
    const key =
      "{name} filed {filed}: {done} done, {open} open, {closed} closed, {other} closed without being completed.";
    expect(messages[key]?.match(/\{\w+\}/g)?.sort()).toEqual(key.match(/\{\w+\}/g)?.sort());
  },
);
