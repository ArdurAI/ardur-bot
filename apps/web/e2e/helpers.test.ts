import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPLOYMENT_OWNER_CLAIM_DEADLINE_MS,
  DEPLOYMENT_OWNER_RENEW_MS,
} from "../../../packages/testkit/src/cli/deployment-owner.js";
import { claimDeploymentOwner } from "./helpers";
import {
  finishSetup,
  nextSetupAction,
  type SetupObservation,
  type SetupProgress,
} from "./setup-completion";

vi.mock("@playwright/test", () => ({ expect }));

import { rpc } from "./helpers";

function fixture(status: number, text: string) {
  const post = vi.fn().mockResolvedValue({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    text: async () => text,
    json: async () => JSON.parse(text),
  });
  return { page: { request: { post } } as unknown as Page, post };
}

describe("e2e RPC helper", () => {
  it("keeps the POST envelope and unwraps a successful JSON reply", async () => {
    const { page, post } = fixture(200, '{"json":{"threadId":"thread"}}');

    await expect(rpc(page, "threads/get", { groupId: "room" })).resolves.toEqual({
      threadId: "thread",
    });
    expect(post).toHaveBeenCalledExactlyOnceWith("/rpc/threads/get", {
      data: { json: { groupId: "room" } },
    });
  });

  it.each([
    [404, "404 Not Found"],
    [502, "<html><body>Bad Gateway</body></html>"],
    [200, "invalid JSON"],
  ])("reports a non-JSON reply with status %s and its first bytes", async (status, text) => {
    const { page } = fixture(status, text);

    await expect(rpc(page, "runs/get", { runId: "run" })).rejects.toThrow(
      `runs/get ${status}: expected JSON, received ${JSON.stringify(text)}`,
    );
  });

  it("bounds the response excerpt", async () => {
    const { page } = fixture(502, `${"x".repeat(200)}omitted-tail`);

    await expect(rpc(page, "threads/get", { groupId: "room" })).rejects.toEqual(
      new Error(`threads/get 502: expected JSON, received ${JSON.stringify("x".repeat(200))}`),
    );
  });

  it("preserves JSON error messages", async () => {
    const { page } = fixture(403, '{"error":{"message":"Forbidden"}}');

    await expect(rpc(page, "threads/get", { groupId: "room" })).rejects.toThrow(
      "threads/get 403: Forbidden",
    );
  });

  it("still rejects an unsuccessful HTTP status with a JSON reply", async () => {
    const { page } = fixture(500, '{"json":null}');

    await expect(rpc(page, "threads/get", { groupId: "room" })).rejects.toThrow(
      "threads/get 500: failed",
    );
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function ownerResponse(status: number) {
  return { ok: () => status >= 200 && status < 300, status: () => status };
}

const idle: SetupProgress = { skipped: false, retried: false, signedIn: false };

function screen(overrides: Partial<SetupObservation> = {}): SetupObservation {
  return {
    url: "http://127.0.0.1:5173/onboarding",
    composerVisible: false,
    composerEnabled: false,
    modelHeading: false,
    integrationsHeading: false,
    setupError: null,
    existingAccount: false,
    signInHeading: false,
    openingChat: false,
    ...overrides,
  };
}

describe("deployment owner claim", () => {
  it("stops retrying a contested deployment owner at the deadline", async () => {
    vi.stubEnv("API_URL", "http://127.0.0.1:9999");
    let now = 5_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const post = vi.fn(async () => {
      now += DEPLOYMENT_OWNER_CLAIM_DEADLINE_MS;
      return ownerResponse(423);
    });
    const page = { request: { post, delete: vi.fn() } } as unknown as Page;

    await expect(claimDeploymentOwner(page)).rejects.toThrow(
      `Timed out waiting for the deployment owner after ${DEPLOYMENT_OWNER_CLAIM_DEADLINE_MS}ms (last status 423)`,
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("fails release when renewal fails and stops renewing", async () => {
    vi.useFakeTimers();
    vi.stubEnv("API_URL", "http://127.0.0.1:9999");
    const post = vi
      .fn()
      .mockResolvedValueOnce(ownerResponse(200))
      .mockResolvedValue(ownerResponse(503));
    const remove = vi.fn().mockResolvedValue(ownerResponse(200));
    const page = { request: { post, delete: remove } } as unknown as Page;

    const release = await claimDeploymentOwner(page);
    await vi.advanceTimersByTimeAsync(DEPLOYMENT_OWNER_RENEW_MS);
    await expect(release()).rejects.toThrow("Cannot renew deployment owner: 503");
    expect(remove).toHaveBeenCalledTimes(1);
    const posts = post.mock.calls.length;
    await vi.advanceTimersByTimeAsync(DEPLOYMENT_OWNER_RENEW_MS * 2);
    expect(post).toHaveBeenCalledTimes(posts);
  });

  it("clears the renewal timer when release fails", async () => {
    vi.useFakeTimers();
    vi.stubEnv("API_URL", "http://127.0.0.1:9999");
    const post = vi.fn().mockResolvedValue(ownerResponse(200));
    const remove = vi.fn().mockResolvedValue(ownerResponse(500));
    const page = { request: { post, delete: remove } } as unknown as Page;

    const release = await claimDeploymentOwner(page);
    await expect(release()).rejects.toThrow("Cannot release deployment owner: 500");
    const posts = post.mock.calls.length;
    await vi.advanceTimersByTimeAsync(DEPLOYMENT_OWNER_RENEW_MS * 3);
    expect(post).toHaveBeenCalledTimes(posts);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("setup completion", () => {
  it("does not treat Opening chat as ready when navigation reaches the app first", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let phase: "opening" | "disabled" | "ready" = "opening";
    let settled = false;
    const done = finishSetup({
      now: () => Date.now(),
      deadlineAt: start + 5_000,
      deadlineMs: 5_000,
      observe: async () => {
        if (phase === "opening") {
          return screen({
            url: "http://127.0.0.1:5173/app/chief",
            openingChat: true,
          });
        }
        if (phase === "disabled") {
          return screen({
            url: "http://127.0.0.1:5173/app/chief",
            composerVisible: true,
            composerEnabled: false,
          });
        }
        return screen({
          url: "http://127.0.0.1:5173/app/chief",
          composerVisible: true,
          composerEnabled: true,
        });
      },
      skipIntegrations: async () => {
        throw new Error("should not skip integrations");
      },
      retrySetup: async () => {
        throw new Error("should not retry setup");
      },
      signInExisting: async () => {
        throw new Error("should not sign in");
      },
      waitForChange: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        phase = phase === "opening" ? "disabled" : "ready";
      },
    }).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(phase).toBe("opening");
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    expect(phase).toBe("disabled");
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(settled).toBe(true);
    expect(phase).toBe("ready");
    expect(
      nextSetupAction(screen({ url: "http://127.0.0.1:5173/app/chief", openingChat: true }), idle),
    ).toEqual({ type: "wait" });
  });

  it("names the chat composer when Opening chat never becomes usable", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const done = finishSetup({
      now: () => Date.now(),
      deadlineAt: start + 1_000,
      deadlineMs: 1_000,
      observe: async () => screen({ url: "http://127.0.0.1:5173/app/chief", openingChat: true }),
      skipIntegrations: async () => undefined,
      retrySetup: async () => undefined,
      signInExisting: async () => undefined,
      waitForChange: (remaining) => new Promise((resolve) => setTimeout(resolve, remaining)),
    });

    const assertion = expect(done).rejects.toThrow(
      "Setup did not become usable within 1000ms. Waited for the chat composer (combobox Message <bot>) to be visible and enabled. Last screen: Opening chat….",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("skips optional integrations, retries a setup error once, and signs in to an existing account", async () => {
    const skipped: string[] = [];
    const retried: string[] = [];
    const signedIn: string[] = [];
    const steps = [
      screen({ integrationsHeading: true }),
      screen({ setupError: "Could not load setup." }),
      screen({ setupError: "Could not load models." }),
      screen({ existingAccount: true }),
      screen({
        url: "http://127.0.0.1:5173/app/chief",
        composerVisible: true,
        composerEnabled: true,
      }),
    ];
    await finishSetup({
      now: () => 0,
      deadlineAt: 20_000,
      deadlineMs: 20_000,
      observe: async () => steps.shift() ?? screen(),
      skipIntegrations: async () => {
        skipped.push("Server integrations");
      },
      retrySetup: async () => {
        retried.push("Retry");
      },
      signInExisting: async () => {
        signedIn.push("existing account");
      },
      waitForChange: async () => undefined,
    });
    expect(skipped).toEqual(["Server integrations"]);
    expect(retried).toEqual(["Retry"]);
    expect(signedIn).toEqual(["existing account"]);
    expect(nextSetupAction(screen({ modelHeading: true }), idle)).toEqual({
      type: "blocked",
      message: "Setup is on Connect a model. The chat composer is not usable.",
    });
  });
});
