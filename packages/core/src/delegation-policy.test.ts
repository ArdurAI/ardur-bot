import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  GOAL_DEFAULT_PER_WORKER_TOKENS,
  GoalStartInputSchema,
  MAX_MODEL_MAX_TOKENS,
  REASONING_MODEL_MAX_TOKENS,
} from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  allowsModelDestination,
  intersectDelegationAuthority,
  minimumDelegationReservation,
  modelDestination,
} from "./delegation-policy.js";

describe("delegation policy", () => {
  it("never expands any authority layer", () => {
    const layers = [
      { scopes: ["ordinary", "delegate"], connectors: ["a", "b"] },
      { scopes: ["ordinary"], connectors: ["b", "c"] },
      { scopes: ["ordinary", "consequential"], connectors: ["b"] },
    ];
    expect(intersectDelegationAuthority(...layers)).toEqual({
      scopes: ["ordinary"],
      connectors: ["b"],
    });
  });
  it.each([undefined, "invalid", "https://cloud.example.test/v1", "http://192.168.1.2/v1"])(
    "does not infer locality for %s",
    (endpoint) => {
      expect(allowsModelDestination({ mode: "local" }, modelDestination(endpoint))).toBe(false);
    },
  );
  it("reserves one request at the worker's effective output cap", () => {
    expect(minimumDelegationReservation()).toBe(
      DEFAULT_MODEL_CONTEXT_WINDOW + DEFAULT_MODEL_MAX_TOKENS,
    );
    expect(minimumDelegationReservation({ contextWindow: 8_192 })).toBe(
      8_192 + DEFAULT_MODEL_MAX_TOKENS,
    );
    const reasoning = minimumDelegationReservation({ reasoning: true });
    expect(reasoning).toBe(DEFAULT_MODEL_CONTEXT_WINDOW + REASONING_MODEL_MAX_TOKENS);
    expect(GOAL_DEFAULT_PER_WORKER_TOKENS).toBe(reasoning);
    // The reported miss: 10,000 input plus a 32,768 reasoning output must not fit a smaller hold.
    expect(10_000 + REASONING_MODEL_MAX_TOKENS).toBeLessThanOrEqual(reasoning);
    expect(minimumDelegationReservation({ contextWindow: 8_192, reasoning: true })).toBe(
      8_192 + REASONING_MODEL_MAX_TOKENS,
    );
    expect(minimumDelegationReservation({ configuredMaxTokens: 65_536 })).toBe(
      DEFAULT_MODEL_CONTEXT_WINDOW + 65_536,
    );
    expect(
      minimumDelegationReservation({ contextWindow: 100_000, configuredMaxTokens: 16_384 }),
    ).toBe(DEFAULT_MODEL_CONTEXT_WINDOW + 16_384);
    expect(
      minimumDelegationReservation({ modelMaxTokens: 8_192, configuredMaxTokens: 65_536 }),
    ).toBe(DEFAULT_MODEL_CONTEXT_WINDOW + 8_192);
    const largest = minimumDelegationReservation({ configuredMaxTokens: MAX_MODEL_MAX_TOKENS });
    expect(largest).toBe(DEFAULT_MODEL_CONTEXT_WINDOW + MAX_MODEL_MAX_TOKENS);
    expect(
      GoalStartInputSchema.safeParse({
        groupId: "group",
        objective: "Ship the budget",
        perWorkerTokens: largest,
      }).success,
    ).toBe(true);
    expect(
      GoalStartInputSchema.safeParse({
        groupId: "group",
        objective: "Ship the budget",
        perWorkerTokens: largest + 1,
      }).success,
    ).toBe(false);
  });
  it("allows only actual loopback and exact listed hosts", () => {
    expect(
      allowsModelDestination({ mode: "local" }, modelDestination("http://127.0.0.1:11434/v1")),
    ).toBe(true);
    expect(
      allowsModelDestination(
        { mode: "hosts", hosts: ["model.example.test"] },
        modelDestination("https://model.example.test/v1"),
      ),
    ).toBe(true);
    expect(
      allowsModelDestination(
        { mode: "hosts", hosts: ["model.example.test"] },
        modelDestination("https://model.example.test.evil/v1"),
      ),
    ).toBe(false);
    expect(allowsModelDestination({ mode: "any" }, modelDestination())).toBe(true);
  });
});
