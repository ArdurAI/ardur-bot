// Development entry for the offline browser test; excluded from the production entry graph.
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { I18nBootstrap } from "../../components/I18nBootstrap";
import { PreferencesProvider } from "../../components/PreferencesProvider";
import { SettingsOverlay } from "../SettingsOverlay";
import { DeleteItemDialog } from "../shell/dialogs";
import "../../styles.css";

if (import.meta.env.DEV) {
  const params = new URLSearchParams(window.location.search);
  createRoot(document.getElementById("root")!).render(
    <I18nBootstrap>
      <MemoryRouter>
        <PreferencesProvider userId="account-fixture">
          {params.has("delete") ? (
            <DeleteItemDialog
              item={{ name: params.get("delete")! }}
              noun="routine"
              onCancel={() => undefined}
              onConfirm={async () => undefined}
            />
          ) : (
            <SettingsOverlay
              initialSection={params.has("general") ? "general" : "account"}
              isDeploymentOwner={params.has("owner")}
              name="Test operator"
              email="owner@example.test"
              avatarStyle="robot"
              onAvatarStyleChange={async () => undefined}
              memoryConfig={null}
              onMemoryConfigChange={() => undefined}
              onClose={() => undefined}
            />
          )}
        </PreferencesProvider>
      </MemoryRouter>
    </I18nBootstrap>,
  );
}
