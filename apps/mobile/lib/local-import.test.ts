import { afterEach, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc }));

import { localImport } from "./local-import";

afterEach(() => vi.clearAllMocks());
it("waits as long as the server does for an import to finish", async () => {
  rpc.mockResolvedValue({ stopped: "host" });
  await expect(localImport.run({ action: "scan" })).resolves.toEqual({ stopped: "host" });
  expect(rpc).toHaveBeenCalledWith("localImport/run", { action: "scan" }, { timeoutMs: 660_000 });
});
