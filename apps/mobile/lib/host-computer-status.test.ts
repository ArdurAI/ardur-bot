import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("exposes the host status and folders on mobile without mutation controls", () => {
  const source = readFileSync(
    new URL("../components/host-computer-status.tsx", import.meta.url),
    "utf8",
  );
  expect(source).toContain('"host/status"');
  expect(source).toContain("status.roots.map");
  expect(source).not.toMatch(
    /host\/disconnect|\.setup\(|\.removeRoot\(|\.addRoot\(|Pressable|Button/,
  );
  expect(readFileSync(new URL("../app/account.tsx", import.meta.url), "utf8")).toContain(
    "<HostComputerStatus />",
  );
});
