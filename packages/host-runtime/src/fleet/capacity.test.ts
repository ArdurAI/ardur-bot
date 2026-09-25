import { unknownCapacity } from "@ardurbot/contracts/fleet";
import { expect, it, vi } from "vitest";
import { cachedCapacity, dockerCapacity, hostCapacity, parseLinuxCapacity } from "./capacity.js";

it("parses Linux measurements and leaves missing MemAvailable unknown", () => {
  const output =
    "8\n0.50 0.20 0.10 1/80 500\nMemTotal: 16777216 kB\nMemAvailable: 8388608 kB\nFilesystem 1024-blocks Used Available Capacity Mounted\n/dev/test 200000 100000 100000 50% /";
  expect(parseLinuxCapacity(output)).toMatchObject({
    cpuCount: 8,
    cpuLoad1m: 0.5,
    memoryTotal: 16 * 1024 ** 3,
    memoryFree: 8 * 1024 ** 3,
    diskFree: 102400000,
    source: "ssh",
  });
  expect(parseLinuxCapacity(output.replace("MemAvailable:", "MemFree:")).memoryFree).toBeNull();
  expect(dockerCapacity({ NCPU: 4, MemTotal: 1024 })).toMatchObject({
    cpuCount: 4,
    memoryTotal: 1024,
    memoryFree: null,
    source: "docker",
  });
});
it("coalesces probes for 30 seconds and bounds failures", async () => {
  let time = 0;
  const probe = vi.fn(async () => unknownCapacity());
  const read = cachedCapacity(probe, () => time);
  await Promise.all([read(), read(), read()]);
  expect(probe).toHaveBeenCalledOnce();
  time = 30000;
  await read();
  expect(probe).toHaveBeenCalledTimes(2);
  expect(
    (
      await cachedCapacity(async () => {
        throw new Error("offline");
      })()
    ).source,
  ).toBe("not-reported");
  const host = await hostCapacity();
  expect(host.cpuCount).toBeGreaterThan(0);
  expect(host.memoryTotal).toBeGreaterThan(0);
  expect(host.source).toBe("host");
});
