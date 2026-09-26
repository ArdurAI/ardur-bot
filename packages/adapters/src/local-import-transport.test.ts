import type { HostRequest } from "@ardurbot/contracts/host-bridge";
import { RuntimePinError } from "@ardurbot/contracts/runtime-pins";
import type { PrismaClient } from "@ardurbot/db";
import { hostLostProblem, importProblem } from "@ardurbot/host-runtime/bridge-wire";
import { LocalImportRescanError } from "@ardurbot/host-runtime/import/scanner";
import { afterEach, expect, it, vi } from "vitest";
import { createImportTransport, LocalImportHostError } from "./local-import.js";

const request = vi.hoisted(() => vi.fn());
vi.mock("@ardurbot/host-runtime/host-client", () => ({
  HostClient: class {
    request(...args: unknown[]) {
      return request(...args);
    }
  },
}));

afterEach(() => {
  request.mockReset();
});

// biome-ignore lint/correctness/useYield: the fixture host always fails before it can yield.
async function* failing(error: Error) {
  throw error;
}

function transport() {
  return createImportTransport({} as PrismaClient, {
    apiUrl: "http://api:3100",
    encryptionKey: "fixture-encryption-material",
    packaged: true,
  });
}
const owner = { spaceId: "space", userId: "owner" };
const scanId = "00000000-0000-4000-8000-000000000001";
const itemId = "00000000-0000-4000-8000-000000000002";

it("maps a host-side rescan problem to a rescan error, not a host error", async () => {
  request.mockReturnValue(
    failing(new RuntimePinError(importProblem("local-import-rescan", "Re-scan this computer."))),
  );
  await expect(transport().read(owner, scanId, itemId)).rejects.toBeInstanceOf(
    LocalImportRescanError,
  );
});

it("maps a host-side item problem to a plain per-item failure, not a host error", async () => {
  request.mockReturnValue(
    failing(
      new RuntimePinError(
        importProblem("local-import-item", "This item is not available for import."),
      ),
    ),
  );
  const error = await transport()
    .read(owner, scanId, itemId)
    .catch((thrown: unknown) => thrown);
  expect(error).not.toBeInstanceOf(LocalImportHostError);
  expect(error).not.toBeInstanceOf(LocalImportRescanError);
  expect((error as Error).message).toBe("This item is not available for import.");
});

it("still maps a lost or busy host to LocalImportHostError", async () => {
  request.mockReturnValue(
    failing(
      new RuntimePinError(
        hostLostProblem({ operation: { op: "import.read" } } as unknown as HostRequest),
      ),
    ),
  );
  await expect(transport().read(owner, scanId, itemId)).rejects.toBeInstanceOf(
    LocalImportHostError,
  );
});
