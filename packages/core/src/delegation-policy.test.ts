import { describe, expect, it } from "vitest";
import {
  allowsModelDestination,
  intersectDelegationAuthority,
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
