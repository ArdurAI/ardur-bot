import { AccessibilityInfo } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetI18nForTests } from "./i18n";
import { watchMotionAllowed, workRecordLabel, workRecordShouldPulse } from "./work-record";

vi.mock("react-native", () => ({
  AccessibilityInfo: { isReduceMotionEnabled: vi.fn(), addEventListener: vi.fn() },
}));

/** Fakes the Reduce Motion setting: its first answer, then later changes. */
function reduceMotionSetting(firstAnswer: Promise<boolean>) {
  let listener: ((reduceMotion: boolean) => void) | undefined;
  const remove = vi.fn();
  vi.mocked(AccessibilityInfo.isReduceMotionEnabled).mockReturnValue(firstAnswer);
  vi.mocked(AccessibilityInfo.addEventListener).mockImplementation(((
    _event: string,
    handler: (reduceMotion: boolean) => void,
  ) => {
    listener = handler;
    return { remove };
  }) as never);
  return { change: (reduceMotion: boolean) => listener?.(reduceMotion), remove };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("work record motion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stops the pulse when Reduce Motion turns on and resumes when it turns off", async () => {
    const setting = reduceMotionSetting(Promise.resolve(false));
    const allowed: boolean[] = [];
    const stop = watchMotionAllowed((value) => allowed.push(value));
    await settle();

    expect(AccessibilityInfo.addEventListener).toHaveBeenCalledWith(
      "reduceMotionChanged",
      expect.any(Function),
    );
    expect(allowed).toEqual([true]);
    setting.change(true);
    expect(allowed).toEqual([true, false]);
    setting.change(false);
    expect(allowed).toEqual([true, false, true]);
    stop();
  });

  it("keeps the record still when Reduce Motion is already on", async () => {
    reduceMotionSetting(Promise.resolve(true));
    const allowed: boolean[] = [];
    const stop = watchMotionAllowed((value) => allowed.push(value));
    await settle();

    expect(allowed).toEqual([false]);
    stop();
  });

  it("removes the subscription on unmount and ignores answers that arrive later", async () => {
    let answer!: (reduceMotion: boolean) => void;
    const setting = reduceMotionSetting(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const allowed: boolean[] = [];
    const stop = watchMotionAllowed((value) => allowed.push(value));

    stop();
    expect(setting.remove).toHaveBeenCalledOnce();
    expect(allowed).toEqual([false]);
    answer(false);
    await settle();
    setting.change(false);
    expect(allowed).toEqual([false]);
  });

  it("lets a change that arrives first win over a stale first answer", async () => {
    let answer!: (reduceMotion: boolean) => void;
    const setting = reduceMotionSetting(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const allowed: boolean[] = [];
    const stop = watchMotionAllowed((value) => allowed.push(value));

    setting.change(true);
    answer(false);
    await settle();
    expect(allowed).toEqual([false]);
    stop();
  });

  it("clears the last answer when the subscription is removed", async () => {
    const setting = reduceMotionSetting(Promise.resolve(false));
    const allowed: boolean[] = [];
    const stop = watchMotionAllowed((value) => allowed.push(value));
    await settle();

    expect(allowed).toEqual([true]);
    stop();
    expect(setting.remove).toHaveBeenCalledOnce();
    expect(allowed).toEqual([true, false]);
  });

  it("does not throw when the platform returns no subscription", () => {
    vi.mocked(AccessibilityInfo.addEventListener).mockReturnValue(undefined as never);
    vi.mocked(AccessibilityInfo.isReduceMotionEnabled).mockReturnValue(Promise.resolve(false));
    const stop = watchMotionAllowed(() => {});
    expect(() => stop()).not.toThrow();
  });

  it("stays still when the setting cannot be read", async () => {
    reduceMotionSetting(Promise.reject(new Error("unavailable")));
    const allowed: boolean[] = [];
    const stop = watchMotionAllowed((value) => allowed.push(value));
    await settle();

    expect(allowed).toEqual([]);
    stop();
  });
});

describe("work record pulse", () => {
  it("starts only while the record is active and motion is allowed", () => {
    expect(workRecordShouldPulse(true, true)).toBe(true);
    expect(workRecordShouldPulse(true, false)).toBe(false);
    expect(workRecordShouldPulse(false, true)).toBe(false);
    expect(workRecordShouldPulse(false, false)).toBe(false);
  });
});

describe("work record label", () => {
  it("names the record with its outcome as well as its current title", () => {
    resetI18nForTests("en");
    expect(workRecordLabel("working", "Checking status")).toBe("Working: Checking status");
    expect(workRecordLabel("done", "pnpm build")).toBe("Done: pnpm build");
    expect(workRecordLabel("failed", "pnpm test")).toBe("Failed: pnpm test");
    expect(workRecordLabel("done", "  ")).toBe("Done");

    resetI18nForTests("ru");
    expect(workRecordLabel("working", "ls")).toBe("Выполняется: ls");
    expect(workRecordLabel("failed", "ls")).toBe("Ошибка: ls");

    resetI18nForTests("zh-CN");
    expect(workRecordLabel("done", "ls")).toBe("完成：ls");
    expect(workRecordLabel("failed", "")).toBe("失败");
    resetI18nForTests("en");
  });
});

import { workingBotsWithoutVisibleActivity } from "@ardurbot/core";

describe("workingBotsWithoutVisibleActivity", () => {
  it("filters out bots that already have visible activity in the message stream", () => {
    const bots = [{ botId: "bot1" }, { botId: "bot2" }];
    const messages = [
      {
        id: "progress:run1",
        botId: "bot1",
        blocks: [{ kind: "progress" as const, text: "Some text" }],
      },
    ];
    const working = workingBotsWithoutVisibleActivity(bots, messages);
    expect(working).toEqual([{ botId: "bot2" }]);
  });
});
