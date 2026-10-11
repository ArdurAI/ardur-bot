import { beforeEach, expect, it, vi } from "vitest";
import { exportEvidenceIdentity, exportRunEvidence } from "./evidence-export";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  create: vi.fn(),
  write: vi.fn(),
  share: vi.fn(),
  delete: vi.fn(),
  context: vi.fn(),
  loadHome: vi.fn(),
  space: vi.fn(),
}));
vi.mock("./api", () => ({
  captureApiRequestContext: mocks.context,
  selectedSpaceId: mocks.space,
  currentApiBase: () => "https://api.example.test",
}));
vi.mock("./dispatch", () => ({ dispatchClient: { loadHome: mocks.loadHome } }));
vi.mock("expo-sharing", () => ({ shareAsync: mocks.share }));
vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" },
  File: class {
    static downloadFileAsync = mocks.download;
    uri = "cache/evidence.tar.gz";
    exists = true;
    delete = mocks.delete;
    create = mocks.create;
    write = mocks.write;
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({
    apiBase: "https://api.example.test",
    headers: { "x-ardurbot-space-id": "space" },
  });
  mocks.space.mockReturnValue("space");
  mocks.loadHome.mockResolvedValue(null);
});
it("downloads authenticated evidence and removes the file after native sharing", async () => {
  await exportRunEvidence("run/1");
  expect(mocks.download).toHaveBeenCalledWith(
    "https://api.example.test/api/evidence/runs/run%2F1?spaceId=space",
    expect.anything(),
    { headers: { "x-ardurbot-space-id": "space" } },
  );
  expect(mocks.share).toHaveBeenCalledWith("cache/evidence.tar.gz", {
    mimeType: "application/gzip",
    UTI: "org.gnu.gnu-zip-archive",
  });
  expect(mocks.delete).toHaveBeenCalledOnce();
});
it("never shares after a denied or unsealed download and cleans a partial file", async () => {
  mocks.download.mockRejectedValue(new Error("409"));
  await expect(exportRunEvidence("run")).rejects.toThrow("409");
  expect(mocks.share).not.toHaveBeenCalled();
  expect(mocks.delete).toHaveBeenCalledOnce();
});
it("cleans the file when sharing fails", async () => {
  mocks.share.mockRejectedValue(new Error("unavailable"));
  await expect(exportRunEvidence("run")).rejects.toThrow("unavailable");
  expect(mocks.delete).toHaveBeenCalledOnce();
});
it("does not share if the selected space changes during download", async () => {
  mocks.download.mockImplementation(async () => mocks.space.mockReturnValue("another-space"));
  await expect(exportRunEvidence("run")).rejects.toThrow();
  expect(mocks.share).not.toHaveBeenCalled();
  expect(mocks.delete).toHaveBeenCalledOnce();
});
it("degrades safely for paired devices without an HTTP archive transport", async () => {
  mocks.loadHome.mockResolvedValue({ id: "home" });
  await expect(exportRunEvidence("run")).rejects.toThrow();
  expect(mocks.context).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});

it("exports only the public identity through native file sharing, including on paired devices", async () => {
  const identity = {
    fingerprint: `sha256:${"a".repeat(64)}`,
    scope: { type: "space" as const, id: "space" },
    keyVersion: 1 as const,
  };
  mocks.loadHome.mockResolvedValue({ id: "home" });
  await exportEvidenceIdentity(identity);
  expect(JSON.parse(mocks.write.mock.calls[0]![0])).toEqual(identity);
  expect(mocks.share).toHaveBeenCalledWith(expect.any(String), {
    mimeType: "application/json",
    UTI: "public.json",
  });
  expect(mocks.delete).toHaveBeenCalledOnce();
  expect(mocks.download).not.toHaveBeenCalled();
});
it("cleans an identity file after failed sharing", async () => {
  mocks.share.mockRejectedValue(new Error("unavailable"));
  await expect(
    exportEvidenceIdentity({
      fingerprint: `sha256:${"a".repeat(64)}`,
      scope: { type: "space", id: "space" },
      keyVersion: 1,
    }),
  ).rejects.toThrow("unavailable");
  expect(mocks.delete).toHaveBeenCalledOnce();
});
