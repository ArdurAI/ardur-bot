import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

describe("Goals API", () => {
  it.each([
    { name: "a non-owner session", isDeploymentOwner: false, authSessionId: "session-1" },
    {
      name: "an owner without an authenticated session",
      isDeploymentOwner: true,
      authSessionId: undefined,
    },
  ])(
    "refuses submit, accept and reject from $name",
    async ({ isDeploymentOwner, authSessionId }) => {
      const findFirst = vi.fn();
      const router = createRouter({
        prisma: { teamGoal: { findFirst } },
        env: { sandboxProvider: "fake" },
      } as unknown as RouterDeps);
      const context = {
        actor: {
          spaceId: "space-1",
          userId: "owner-1",
          email: "owner@example.test",
          isDeploymentOwner,
        },
        authSessionId,
      };
      const handler = new RPCHandler(router);
      for (const operation of ["submit", "accept", "reject", "reviewCondition"]) {
        const { response } = await handler.handle(
          new Request(`http://127.0.0.1/rpc/goals/${operation}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              json: {
                goalId: "goal-1",
                summary: "Candidate",
                revisionId: "revision-1",
                reworkNotes: "Review again",
                conditionId: "cond-final",
                status: "pass",
              },
            }),
          }),
          { prefix: "/rpc", context },
        );
        expect(response?.status).toBe(403);
        expect(await response?.json()).toMatchObject({ json: { code: "FORBIDDEN" } });
      }
      expect(findFirst).not.toHaveBeenCalled();
    },
  );
});

it.each([
  ["accept", "revision-changed"],
  ["reject", "revision-changed"],
  ["accept", "work-active"],
] as const)("returns a safe conflict reason for %s (%s)", async (operation, reason) => {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    teamGoal: { findUniqueOrThrow: vi.fn(async () => ({ status: "completed" })) },
    goalRevision: {
      findFirst: vi.fn(async () => ({
        id: reason === "revision-changed" ? "new-revision" : "revision-1",
      })),
    },
    goalVerdict: { findFirst: vi.fn(async () => null), create: vi.fn() },
    delegationRoot: { findUnique: vi.fn(async () => ({ reservedTokens: 10 })) },
  };
  const router = createRouter({
    prisma: {
      teamGoal: {
        findFirst: vi.fn(async () => ({
          id: "goal-1",
          threadId: "thread-1",
          rootTaskId: "root-1",
        })),
      },
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    },
    env: { sandboxProvider: "fake" },
  } as unknown as RouterDeps);
  const { response } = await new RPCHandler(router).handle(
    new Request(`http://127.0.0.1/rpc/goals/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        json: { goalId: "goal-1", revisionId: "revision-1", reworkNotes: "Review again" },
      }),
    }),
    {
      prefix: "/rpc",
      context: {
        actor: {
          spaceId: "space-1",
          userId: "owner-1",
          email: "owner@example.test",
          isDeploymentOwner: true,
        },
        authSessionId: "session-1",
      },
    },
  );
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({ json: { code: "CONFLICT", data: { reason } } });
  expect(tx.goalVerdict.create).not.toHaveBeenCalled();
});

it("maps a cross-scope refusal to forbidden, not a server error", async () => {
  const router = createRouter({
    prisma: { teamGoal: { findFirst: vi.fn(async () => null) } },
    env: { sandboxProvider: "fake" },
  } as unknown as RouterDeps);
  const { response } = await new RPCHandler(router).handle(
    new Request("http://127.0.0.1/rpc/goals/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { goalId: "goal-1", revisionId: "revision-1" } }),
    }),
    {
      prefix: "/rpc",
      context: {
        actor: {
          spaceId: "space-1",
          userId: "owner-1",
          email: "owner@example.test",
          isDeploymentOwner: true,
        },
        authSessionId: "session-1",
      },
    },
  );
  expect(response?.status).toBe(403);
  expect(await response?.json()).toMatchObject({ json: { code: "FORBIDDEN" } });
});

it("maps an already reviewed decision to conflict", async () => {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    teamGoal: { findUniqueOrThrow: vi.fn(async () => ({ status: "completed" })) },
    goalRevision: { findFirst: vi.fn(async () => ({ id: "revision-1", conditions: [] })) },
    goalVerdict: {
      findFirst: vi.fn(async () => ({ type: "reject", id: "verdict-1" })),
      create: vi.fn(),
    },
    delegationRoot: { findUnique: vi.fn(async () => ({ reservedTokens: 0 })) },
  };
  const router = createRouter({
    prisma: {
      teamGoal: {
        findFirst: vi.fn(async () => ({
          id: "goal-1",
          threadId: "thread-1",
          rootTaskId: "root-1",
        })),
      },
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    },
    env: { sandboxProvider: "fake" },
  } as unknown as RouterDeps);
  const { response } = await new RPCHandler(router).handle(
    new Request("http://127.0.0.1/rpc/goals/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { goalId: "goal-1", revisionId: "revision-1" } }),
    }),
    {
      prefix: "/rpc",
      context: {
        actor: {
          spaceId: "space-1",
          userId: "owner-1",
          email: "owner@example.test",
          isDeploymentOwner: true,
        },
        authSessionId: "session-1",
      },
    },
  );
  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({
    json: { code: "CONFLICT", data: { reason: "already-reviewed" } },
  });
  expect(tx.goalVerdict.create).not.toHaveBeenCalled();
});
