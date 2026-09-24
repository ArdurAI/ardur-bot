import type { OAuthCredential } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import { PiRuntimeCredentialStore } from "./pi-credentials.js";
import { AnthropicOAuthUnavailableError } from "./pi-oauth.js";

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60 * 60_000,
    ...overrides,
  };
}

describe("PiRuntimeCredentialStore", () => {
  it("rejects Anthropic OAuth before Pi can read or refresh it", () => {
    expect(() => new PiRuntimeCredentialStore("anthropic", credential())).toThrow(
      AnthropicOAuthUnavailableError,
    );
  });

  it("rejects Anthropic OAuth writes before persistence", async () => {
    const persist = vi.fn();
    const store = new PiRuntimeCredentialStore("anthropic", undefined, persist);
    await expect(store.modify("anthropic", async () => credential())).rejects.toThrow(
      AnthropicOAuthUnavailableError,
    );
    expect(persist).not.toHaveBeenCalled();
    expect(await store.read("anthropic")).toBeUndefined();
  });

  it("continues to supply an Anthropic API key to Pi", async () => {
    const store = new PiRuntimeCredentialStore("anthropic", {
      type: "api_key",
      key: "fake-api-key",
    });
    expect((await builtinModels({ credentials: store }).getAuth("anthropic"))?.auth.apiKey).toBe(
      "fake-api-key",
    );
  });
  it("does not configure openai-codex without a stored OAuth credential", async () => {
    expect(await builtinModels().getAuth("openai-codex")).toBeUndefined();
  });

  it("bridges an encrypted OAuth credential into the OAuth-only Codex provider", async () => {
    const store = new PiRuntimeCredentialStore("openai-codex", credential());
    const models = builtinModels({ credentials: store });

    const auth = await models.getAuth("openai-codex");

    expect(auth?.auth.apiKey).toBe("access-token");
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("serializes refresh publication without exposing credential values in metadata", async () => {
    let persisted: OAuthCredential | undefined;
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ access: "old-access" }),
      async (next) => {
        persisted = next;
      },
    );

    await store.modify("openai-codex", async () => credential({ access: "new-access" }));

    expect(persisted?.access).toBe("new-access");
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });
});
