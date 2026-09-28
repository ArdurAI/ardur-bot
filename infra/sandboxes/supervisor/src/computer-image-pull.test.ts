import { Readable } from "node:stream";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import {
  computerImagePullFailure,
  ensureDockerComputerImage,
  readImagePullProgress,
} from "./computer-image-pull.js";

describe("Docker image pull progress", () => {
  it("sums layer bytes across split JSON frames", async () => {
    const progress: Array<number | null> = [];
    await readImagePullProgress(
      Readable.from([
        '{"id":"a","progressDetail":{"current":20,"total":100}}\n{"id":"b","progressDetail":{"current":',
        '70,"total":100}}\n',
      ]),
      (percent) => {
        progress.push(percent);
      },
    );
    expect(progress).toEqual([20, 45]);
  });

  it("reports indeterminate progress when totals are unavailable", async () => {
    const progress = vi.fn();
    await readImagePullProgress(Readable.from(['{"status":"Pulling manifest"}\n']), progress);
    expect(progress).toHaveBeenCalledWith(null);
  });

  it("rejects engine error frames and truncated streams", async () => {
    await expect(
      readImagePullProgress(Readable.from(['{"error":"manifest unknown"}\n']), () => undefined),
    ).rejects.toThrow("manifest unknown");
    await expect(
      readImagePullProgress(Readable.from(['{"id":"a"']), () => undefined),
    ).rejects.toThrow("ended unexpectedly");
  });
});

describe("Docker image pull admission", () => {
  const image = "ghcr.io/ardurai/ardur-bot/computer:dev";
  it("shares one pull across concurrent bots and permits a later local inspect", async () => {
    let present = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pull = vi.fn(async () => {
      await gate;
      present = true;
      return Readable.from(['{"status":"Pull complete"}\n']);
    });
    const inspect = vi.fn(async () => {
      if (!present) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return { Id: "image" };
    });
    const engine = { getImage: () => ({ inspect }), pull } as unknown as Docker;
    const secondProgress = vi.fn();
    const first = ensureDockerComputerImage(engine, image, () => {
      throw new Error("waiter disconnected");
    });
    const second = ensureDockerComputerImage(engine, image, secondProgress);
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
    expect(secondProgress).toHaveBeenCalledWith(null);
    await ensureDockerComputerImage(engine, image);
    expect(pull).toHaveBeenCalledOnce();
  });

  it("fails both waiters without caching a failed pull", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pull = vi.fn(async () => {
      await gate;
      return Readable.from(['{"error":"manifest unknown"}\n']);
    });
    const engine = {
      getImage: () => ({
        inspect: async () => {
          throw Object.assign(new Error("missing"), { statusCode: 404 });
        },
      }),
      pull,
    } as unknown as Docker;
    const first = ensureDockerComputerImage(engine, image);
    const second = ensureDockerComputerImage(engine, image);
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
    release();
    await expect(first).rejects.toThrow("not found or private");
    await expect(second).rejects.toThrow("not found or private");
    expect(pull).toHaveBeenCalledOnce();
    await expect(ensureDockerComputerImage(engine, image)).rejects.toThrow("not found or private");
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it.each([
    [Object.assign(new Error("unauthorized"), { statusCode: 401 }), "not found or private"],
    [Object.assign(new Error("socket failed"), { code: "ECONNRESET" }), "network error"],
    [new Error("unrecognized failure"), "download failed"],
  ])("classifies %s", (error, reason) => {
    expect(computerImagePullFailure(error).message).toBe(
      `The bot computer image could not be downloaded: ${reason}. Check the network, or build it locally with \`pnpm build:computers\`.`,
    );
  });
});
