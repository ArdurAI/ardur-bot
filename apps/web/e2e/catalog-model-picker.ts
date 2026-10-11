import type { ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import { catalogModelChoices, recommendedDefaultModelId } from "@ardurbot/core";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { rpc } from "./helpers";

/** Choose a model, then its explicit connection; do not depend on a provider sidebar. */
export async function selectCatalogModel(
  page: Page,
  provider: string,
  modelId?: string,
  credentialId?: string,
) {
  const [catalog, credentials] = await Promise.all([
    rpc<ModelCatalogEntry[]>(page, "models/list", {}),
    rpc<ModelCredential[]>(page, "models/credentials", {}),
  ]);
  const providerModels = catalog.filter((entry) => entry.provider === provider);
  const id =
    modelId ??
    providerModels.find((entry) => entry.placeholder)?.id ??
    recommendedDefaultModelId(
      provider,
      providerModels.map((entry) => entry.id),
    );
  const models = catalogModelChoices(catalog, credentials);
  const model = models.find((model) =>
    model.connections.some(
      (choice) => choice.entry.provider === provider && choice.entry.id === id,
    ),
  );
  if (!model) throw new Error("Catalog model fixture is unavailable.");
  const connections = model.connections.filter(
    (choice) =>
      choice.entry.provider === provider &&
      choice.entry.id === id &&
      (!credentialId || choice.credential?.id === credentialId),
  );
  if (connections.length !== 1) throw new Error("Choose an explicit connection for this fixture.");
  const connection = connections[0]!;
  const picker = page.getByRole("combobox", { name: "Model", exact: true });
  await picker.click();
  await page.getByRole("combobox", { name: "Search models" }).fill(model.label);
  await page
    .getByRole("option")
    .filter({ has: page.getByText(model.label, { exact: true }) })
    .click();
  if (model.connections.length > 1) {
    const chooser = page.getByRole("combobox", { name: "Choose connection" });
    await expect(chooser).toBeVisible();
    await chooser.selectOption(connection.key);
  }
  await expect(picker).toHaveText(model.label);
}
