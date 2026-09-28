import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("tts-lazy", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls onError when loading speaker fails", async () => {
    vi.doMock("./tts", () => Promise.reject(new Error("Network error loading tts chunk")));

    const { withSpeaker } = await import("./tts-lazy");
    const action = vi.fn();
    const onError = vi.fn();

    await withSpeaker(action, onError);

    expect(action).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    const error = onError.mock.calls[0]?.[0] as Error & { cause?: Error };
    expect(error.cause?.message ?? error.message).toContain("Network error loading tts chunk");
  });

  it("swallows failure when onError is not supplied", async () => {
    vi.doMock("./tts", () => Promise.reject(new Error("Network error loading tts chunk")));

    const { withSpeaker } = await import("./tts-lazy");
    const action = vi.fn();

    await expect(withSpeaker(action)).resolves.toBeUndefined();
    expect(action).not.toHaveBeenCalled();
  });

  it("runs action once speaker is successfully loaded", async () => {
    const fakeSpeaker = {
      speak: vi.fn(),
      stop: vi.fn(),
      subscribe: vi.fn(),
    };
    vi.doMock("./tts", () => ({
      speaker: fakeSpeaker,
    }));

    const { withSpeaker } = await import("./tts-lazy");
    const action = vi.fn();
    const onError = vi.fn();

    await withSpeaker(action, onError);

    expect(action).toHaveBeenCalledWith(fakeSpeaker);
    expect(onError).not.toHaveBeenCalled();
  });
});
