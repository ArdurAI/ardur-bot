import { afterEach, expect, it, vi } from "vitest";
import { updateDrain } from "./restart-drain.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, input) => {
    const { id } = JSON.parse(String(input?.body));
    return Response.json({ ok: true, id });
  });
  return { fetch, drain: updateDrain("http://fake-api.invalid", "fake-updater-token", fetch) };
}
it("reopens the same drain after the API briefly disappears during recreate", async () => {
  vi.useFakeTimers();
  const f = fixture();
  expect(await f.drain.begin()).toBe(true);
  f.fetch.mockRejectedValueOnce(new Error("Fake API restarting"));
  const reopened = f.drain.clear();
  await vi.advanceTimersByTimeAsync(1_000);
  await reopened;
  const ids = f.fetch.mock.calls.map(([, input]) => JSON.parse(String(input?.body)).id);
  expect(new Set(ids).size).toBe(1);
  expect(f.fetch).toHaveBeenCalledTimes(3);
});
it("can reopen admission when the drain response was lost", async () => {
  const f = fixture();
  f.fetch.mockRejectedValueOnce(new Error("Fake response lost"));
  await expect(f.drain.begin()).rejects.toThrow("Fake response lost");
  await f.drain.clear();
  expect(f.fetch.mock.calls.map(([, input]) => JSON.parse(String(input?.body)).id)[0]).toBe(
    JSON.parse(String(f.fetch.mock.calls[1]?.[1]?.body)).id,
  );
});
it("bounds reopening attempts and reports an unreachable API", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.drain.begin();
  f.fetch.mockRejectedValue(new Error("Fake API unavailable"));
  const reopened = f.drain.clear().catch((error) => error);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(await reopened).toEqual(
    expect.objectContaining({ message: "Could not reopen turn admission after the update." }),
  );
  expect(f.fetch).toHaveBeenCalledTimes(6);
});
