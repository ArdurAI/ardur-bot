// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanRunChoice } from "./use-can-run";
import { useCanRun } from "./use-can-run";

const validatePin = vi.hoisted(() => vi.fn());
vi.mock("./rpc", () => ({ rpc: { models: { validatePin } } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray) => parts.join(""),
  }),
}));
vi.mock("./failure-category-copy", () => ({ failureCategoryMessages: {} }));
vi.mock("./hermes-refusal", () => ({ hermesContextMessage: (message: string) => message }));

const choice: CanRunChoice = {
  runtimeKind: "pi",
  provider: "openai",
  modelId: "fixture",
  credentialId: "connection",
  effort: null,
  botId: "bot",
  runtimeExperimental: false,
};
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Form({ value }: { value: CanRunChoice | null }) {
  const check = useCanRun(value);
  return (
    <>
      <button type="button" disabled={check.blocked} onClick={check.recheck}>
        Save
      </button>
      <span>{check.error}</span>
    </>
  );
}
async function render(value: CanRunChoice | null) {
  await act(async () => root.render(<Form value={value} />));
}
function deferred() {
  let resolve!: (value: { ok: true }) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<{ ok: true }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  validatePin.mockReset();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

it("keeps Save blocked until the latest draft succeeds, ignoring stale successes and failures", async () => {
  const old = deferred(),
    current = deferred(),
    latest = deferred();
  validatePin
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise)
    .mockReturnValueOnce(latest.promise);
  await render(choice);
  await render({ ...choice, runtimeExperimental: true });
  await act(async () => old.resolve({ ok: true }));
  expect(node.querySelector("button")!.disabled).toBe(true);
  await render({ ...choice, modelId: "another" });
  await act(async () => current.reject({ code: "BAD_REQUEST", message: "stale refusal" }));
  expect(node.textContent).not.toContain("stale refusal");
  expect(node.querySelector("button")!.disabled).toBe(true);
  await act(async () => latest.resolve({ ok: true }));
  expect(node.querySelector("button")!.disabled).toBe(false);
});

it("a saved success cannot unlock a new draft or a changed computer", async () => {
  const next = deferred(),
    computer = deferred();
  validatePin
    .mockResolvedValueOnce({ ok: true })
    .mockReturnValueOnce(next.promise)
    .mockReturnValueOnce(computer.promise);
  await render(choice);
  expect(node.querySelector("button")!.disabled).toBe(false);
  await render({ ...choice, runtimeExperimental: true });
  expect(node.querySelector("button")!.disabled).toBe(true);
  await act(async () => next.resolve({ ok: true }));
  expect(node.querySelector("button")!.disabled).toBe(false);
  await act(async () => window.dispatchEvent(new Event("fleet:changed")));
  expect(node.querySelector("button")!.disabled).toBe(true);
  await act(async () => computer.reject({ code: "BAD_REQUEST", message: "computer changed" }));
  expect(node.textContent).toContain("computer changed");
  expect(node.querySelector("button")!.disabled).toBe(true);
});

it.each([
  null,
  new Error("private transport details"),
  { code: "INTERNAL_SERVER_ERROR", message: "private details" },
])("fails closed without leaking transport errors: %s", async (reason) => {
  validatePin.mockRejectedValueOnce(reason).mockResolvedValueOnce({ ok: true });
  await render(choice);
  expect(node.textContent).toContain("Could not check the model. Try again.");
  expect(node.textContent).not.toContain("private");
  expect(node.querySelector("button")!.disabled).toBe(true);
  await act(async () =>
    node.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  // Disabled Save does not itself retry. External connection changes do.
  await act(async () => window.dispatchEvent(new Event("models:changed")));
  expect(node.querySelector("button")!.disabled).toBe(false);
});

it("does not check an inherited group override and ignores its previous request", async () => {
  const pending = deferred();
  validatePin.mockReturnValueOnce(pending.promise);
  await render(choice);
  await render(null);
  await act(async () => pending.reject({ code: "BAD_REQUEST", message: "old" }));
  expect(node.querySelector("button")!.disabled).toBe(false);
  expect(node.textContent).not.toContain("old");
});
