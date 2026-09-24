// Isolated development entry for the offline browser test; not part of the production entry graph.
import { createRoot } from "react-dom/client";
import { I18nBootstrap } from "../../components/I18nBootstrap";
import { AccountSettings } from "./AccountSettings";
import "../../styles.css";

if (import.meta.env.DEV) {
  createRoot(document.getElementById("root")!).render(
    <I18nBootstrap>
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="mb-6 text-2xl font-medium">Account</h1>
        <AccountSettings />
      </main>
    </I18nBootstrap>,
  );
}
