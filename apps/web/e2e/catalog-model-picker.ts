import type { ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import {
  availableCatalogModels,
  catalogModelChoices,
  recommendedDefaultModelId,
  unavailableSubscriptionModel,
} from "@ardurbot/core";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Choose a model, then its explicit connection; do not depend on a provider sidebar. */
export async function selectCatalogModel(
  page: Page,
  provider: string,
  modelId?: string,
  credentialId?: string,
) {
  // Browser fetch shares the UI's session and route fixtures. APIRequestContext
  // bypasses page routes and would accidentally call the real server in docs.
  const [catalog, credentials] = (await page.evaluate(async () => {
    return Promise.all(
      ["models/list", "models/credentials"].map(async (procedure) => {
        const response = await fetch(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ json: {} }),
        });
        if (!response.ok) throw new Error(`${procedure} ${response.status()}`);
        return (await response.json()).json;
      }),
    );
  })) as [ModelCatalogEntry[], ModelCredential[]];
  const providerModels = catalog.filter((entry) => entry.provider === provider);
  const id =
    modelId ??
    providerModels.find((entry) => entry.placeholder)?.id ??
    recommendedDefaultModelId(
      provider,
      providerModels.map((entry) => entry.id),
    );
  const showAllToggle = page.getByRole("checkbox", { name: "Show all models", exact: true });
  if (unavailableSubscriptionModel(catalog, provider, id)) await showAllToggle.check();
  const showAll = (await showAllToggle.isVisible()) && (await showAllToggle.isChecked());
  const models = availableCatalogModels(catalogModelChoices(catalog, credentials), showAll);
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
