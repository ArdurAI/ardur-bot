import { expect, it, vi } from "vitest";
import { readEnabledRoutines } from "./routines.js";

it("polls the fixed loopback endpoint with private authentication and no redirects", async () => {
  const request = vi.fn(async () => Response.json({ count: 2 }));
  expect(await readEnabledRoutines("http://127.0.0.1:5173/app", "fixture-token", request)).toBe(2);
  expect(request).toHaveBeenCalledWith(
    "http://127.0.0.1:5173/local/system/routines",
    expect.objectContaining({
      headers: { "x-ardurbot-local-settings-token": "fixture-token" },
      credentials: "omit",
      redirect: "error",
    }),
  );
  await expect(
    readEnabledRoutines("https://outside.example.invalid", "fixture-token", request),
  ).rejects.toThrow("local desktop stack");
  expect(request).toHaveBeenCalledOnce();
});
it.each([-1, 1.5, "4", null, Number.MAX_SAFE_INTEGER + 1])(
  "rejects an invalid routine count %s",
  async (count) => {
    await expect(
      readEnabledRoutines("http://localhost:5173", "fixture", async () => Response.json({ count })),
    ).rejects.toThrow("routine status");
  },
);
