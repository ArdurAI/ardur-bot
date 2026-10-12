import type { ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { catalogModelChoices, searchCatalogModels } from "./catalog-selection.js";

const model = (
  provider: string,
  id = "shared-model",
  extra: Partial<ModelCatalogEntry> = {},
): ModelCatalogEntry => ({
  provider,
  id,
  label: "Shared model",
  billing: "",
  auth: "api-key",
  ...extra,
});
const connection = (
  id: string,
  provider = "first",
  extra: Partial<ModelCredential> = {},
): ModelCredential => ({ id, provider, label: id, hasKey: true, isDefault: false, ...extra });

describe("catalogModelChoices", () => {
  it("groups a model across providers without replacing their exact ids", () => {
    const choices = catalogModelChoices(
      [model("first"), model("gateway", "first/shared-model", { catalogId: "shared-model" })],
      [connection("saved")],
    );
    expect(choices).toHaveLength(1);
    expect(choices[0]?.ready).toBe(true);
    expect(
      choices[0]?.connections.map((choice) => [
        choice.entry.provider,
        choice.entry.id,
        choice.requirement,
      ]),
    ).toEqual([
      ["first", "shared-model", "ready"],
      ["gateway", "first/shared-model", "api-key"],
    ]);
    expect(searchCatalogModels(choices, "gateway shared")).toEqual(choices);
    expect(searchCatalogModels(choices, "absent")).toEqual([]);
  });
  it("lists every saved connection and binds credential-scoped models", () => {
    const choices = catalogModelChoices(
      [model("first"), model("first", "bound", { credentialId: "second" })],
      [connection("first"), connection("second")],
    );
    expect(choices[0]?.connections.map((choice) => choice.credential?.id)).toEqual([
      "first",
      "second",
    ]);
    expect(choices[1]?.connections.map((choice) => choice.credential?.id)).toEqual(["second"]);
    expect(new Set(choices[0]?.connections.map((choice) => choice.key)).size).toBe(2);
  });
  it("reuses an existing personal sign-in and does not invent one after cancellation", () => {
    const catalog = [model("signed", "model", { auth: "oauth", signIn: "device-code" })];
    expect(
      catalogModelChoices(catalog, [connection("personal", "signed", { oauth: true })])[0]
        ?.connections[0]?.requirement,
    ).toBe("ready");
    expect(
      catalogModelChoices(catalog, [connection("key", "signed")])[0]?.connections[0]?.requirement,
    ).toBe("sign-in");
    expect(catalogModelChoices(catalog, [])[0]?.connections[0]?.requirement).toBe("sign-in");
  });
  it("does not mark missing or refused credentials ready", () => {
    const catalog = [model("first")];
    for (const credentials of [
      [],
      [connection("missing", "first", { hasKey: false })],
      [connection("refused", "first", { connectionIssue: "api-key-required" })],
    ]) {
      expect(catalogModelChoices(catalog, credentials)[0]?.connections[0]?.requirement).toBe(
        "api-key",
      );
    }
  });
  it("keeps local models and the local-server setup path available without hosted sign-in", () => {
    const catalog = [
      model("ollama", "local:small", { credentialId: "local" }),
      model("ollama", "__setup", { placeholder: true }),
    ];
    const choices = catalogModelChoices(catalog, [connection("local", "ollama")]);
    expect(choices.map((choice) => choice.connections[0]?.requirement)).toEqual([
      "ready",
      "local-server",
    ]);
    expect(catalogModelChoices(catalog, [])[0]?.connections[0]?.requirement).toBe("local-server");
  });
  it("keeps custom endpoints bound even when they use the same model id", () => {
    const choices = catalogModelChoices(
      [],
      [
        connection("one", "openai-compatible", {
          modelId: "custom",
          baseUrl: "https://example.invalid/v1",
        }),
        connection("two", "openai-compatible", {
          modelId: "custom",
          baseUrl: "https://example.invalid/v1",
        }),
      ],
    );
    expect(choices).toHaveLength(1);
    expect(choices[0]?.connections.map((choice) => choice.credential?.id)).toEqual(["one", "two"]);
  });
  it("does not merge local tags or unrelated versions that share a label", () => {
    expect(
      catalogModelChoices(
        [
          model("first", "v1"),
          model("first", "v2"),
          model("ollama", "v1"),
          model("ollama", "v1:small"),
        ],
        [],
      ),
    ).toHaveLength(4);
  });
  it("does not offer API connections to a native runtime or sign-in connections to Hermes", () => {
    expect(
      catalogModelChoices([model("first")], [connection("key")], "claude-code")[0]?.connections[0]
        ?.requirement,
    ).toBe("unavailable");
    expect(
      catalogModelChoices(
        [model("signed", "model", { auth: "oauth", signIn: "device-code" })],
        [connection("signed", "signed", { oauth: true })],
        "hermes",
      )[0]?.ready,
    ).toBe(false);
  });
});

it("preserves full namespaces when unrelated model ids share a suffix", () => {
  expect(
    catalogModelChoices(
      [
        model("gateway", "vendor-a/foo/bar"),
        model("gateway", "vendor-b/bar"),
        model("vendor-b", "bar"),
      ],
      [],
    ),
  ).toHaveLength(3);
});
it("uses explicit catalog identity across different provider id formats", () => {
  const choices = catalogModelChoices(
    [
      model("anthropic", "claude-fable-5", { catalogId: "claude-fable-5" }),
      model("amazon-bedrock", "anthropic.claude-fable-5", { catalogId: "claude-fable-5" }),
      model("gateway", "anthropic/claude-fable-5", { catalogId: "claude-fable-5" }),
    ],
    [],
  );
  expect(choices).toHaveLength(1);
  expect(choices[0]?.connections.map((choice) => choice.entry.id)).toEqual([
    "claude-fable-5",
    "anthropic.claude-fable-5",
    "anthropic/claude-fable-5",
  ]);
});
