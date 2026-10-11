import { describe, expect, it } from "vitest";
import type { SetupReadResult } from "./setup-step.js";
import { setupStep } from "./setup-step.js";

const loading = { status: "loading" } as const;
const failed = { status: "failed" } as const;
const catalog = { status: "loaded", value: [] } as const;
const account = (needsModel: boolean) => ({ status: "loaded", value: { needsModel } }) as const;

describe("setupStep", () => {
  it.each([loading, failed, catalog])(
    "keeps an account failure in setup with catalog %j",
    (models) => {
      expect(setupStep(failed, models)).toBe("account-error");
    },
  );

  it.each([true, false])("shows a catalog failure even when needsModel is %s", (needsModel) => {
    expect(setupStep(account(needsModel), failed)).toBe("catalog-error");
  });

  it.each([true, false])("waits for the catalog when needsModel is %s", (needsModel) => {
    expect(setupStep(account(needsModel), loading)).toBe("loading");
  });

  it.each([loading, failed, catalog])(
    "waits for account confirmation with catalog %j",
    (models) => {
      expect(setupStep(loading, models)).toBe("loading");
    },
  );

  it("keeps a successfully loaded empty catalog distinct from failure", () => {
    expect(setupStep(account(true), catalog)).toBe("model");
  });

  it("uses the confirmed account and integration state to choose the next step", () => {
    expect(setupStep(account(true), catalog, true)).toBe("model");
    expect(setupStep(account(false), catalog, true)).toBe("integrations");
    expect(setupStep(account(false), catalog, false)).toBe("bot");
  });

  it("recovers after failed reads are retried successfully", () => {
    expect(setupStep(failed, failed)).toBe("account-error");
    expect(setupStep(loading, loading)).toBe("loading");
    expect(setupStep(account(false), failed)).toBe("catalog-error");
    expect(setupStep(account(false), catalog)).toBe("bot");
  });

  it.each(["account", "catalog"] as const)("waits for a deferred %s response", async (deferred) => {
    let accountRead: SetupReadResult<{ needsModel: boolean }> = loading;
    let catalogRead: SetupReadResult<unknown> = loading;
    let resolve!: () => void;
    const response = new Promise<void>((done) => {
      resolve = done;
    });
    const read = response.then(() => {
      if (deferred === "account") accountRead = account(false);
      else catalogRead = catalog;
    });
    if (deferred === "account") catalogRead = catalog;
    else accountRead = account(false);
    expect(setupStep(accountRead, catalogRead)).toBe("loading");
    resolve();
    await read;
    expect(setupStep(accountRead, catalogRead)).toBe("bot");
  });
});
