import { beforeEach, expect, it, vi } from "vitest";
import { exportCommandRun } from "./command-export";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  shareAsync: vi.fn(),
  create: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("./api", () => ({ rpc: mocks.rpc }));
vi.mock("expo-sharing", () => ({ shareAsync: mocks.shareAsync }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" },
  File: class {
    uri = "cache/command.log";
    create = mocks.create;
    write = mocks.write;
    delete = mocks.delete;
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpc.mockResolvedValue({ text: "Run: run-1\n[Redacted export]\n", filename: "run.log" });
});

it("exports only server-returned text through native sharing and removes the cache file", async () => {
  await exportCommandRun("run-1");
  expect(mocks.rpc).toHaveBeenCalledWith("commands/export", { runId: "run-1" });
  expect(mocks.write).toHaveBeenCalledWith("Run: run-1\n[Redacted export]\n");
  expect(mocks.shareAsync).toHaveBeenCalledWith("cache/command.log", {
    mimeType: "text/plain",
    UTI: "public.plain-text",
  });
  expect(mocks.delete).toHaveBeenCalledOnce();
});

it("does not create or share a file after an access denial", async () => {
  mocks.rpc.mockRejectedValue(new Error("denied"));
  await expect(exportCommandRun("run-1")).rejects.toThrow("denied");
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.shareAsync).not.toHaveBeenCalled();
});

it("removes the temporary export when native sharing fails", async () => {
  mocks.shareAsync.mockRejectedValue(new Error("unavailable"));
  await expect(exportCommandRun("run-1")).rejects.toThrow("unavailable");
  expect(mocks.delete).toHaveBeenCalledOnce();
});
